"""Video object detection helpers for cleanup verification."""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Iterable

import cv2
import httpx

MODEL_DIR = Path(__file__).resolve().parents[1] / "models"
PROTOTXT_PATH = MODEL_DIR / "deploy.prototxt"
CAFFEMODEL_PATH = MODEL_DIR / "mobilenet_iter_73000.caffemodel"

PROTOTXT_URL = (
    "https://raw.githubusercontent.com/chuanqi305/MobileNet-SSD/master/"
    "deploy.prototxt"
)
CAFFEMODEL_URL = (
    "https://github.com/chuanqi305/MobileNet-SSD/raw/master/"
    "mobilenet_iter_73000.caffemodel"
)

CLASS_NAMES = [
    "background",
    "aeroplane",
    "bicycle",
    "bird",
    "boat",
    "bottle",
    "bus",
    "car",
    "cat",
    "chair",
    "cow",
    "diningtable",
    "dog",
    "horse",
    "motorbike",
    "person",
    "pottedplant",
    "sheep",
    "sofa",
    "train",
    "tvmonitor",
]


@dataclass
class DetectionSummary:
    # `labels` kept for compatibility with existing callers; now represents
    # unique tracked objects per class (not per-frame detection totals).
    labels: Counter[str]
    unique_labels: Counter[str]
    frame_detection_labels: Counter[str]
    frames_sampled: int


def _download_file(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=120.0, follow_redirects=True) as client:
        response = client.get(url)
        response.raise_for_status()
        destination.write_bytes(response.content)


def ensure_model_files() -> None:
    if not PROTOTXT_PATH.exists():
        _download_file(PROTOTXT_URL, PROTOTXT_PATH)
    if not CAFFEMODEL_PATH.exists():
        _download_file(CAFFEMODEL_URL, CAFFEMODEL_PATH)


@lru_cache(maxsize=1)
def load_detector() -> cv2.dnn_Net:
    ensure_model_files()
    return cv2.dnn.readNetFromCaffe(str(PROTOTXT_PATH), str(CAFFEMODEL_PATH))


def detect_objects_in_frame(frame, conf_threshold: float = 0.4) -> list[tuple[str, float, tuple[int, int, int, int]]]:
    net = load_detector()
    height, width = frame.shape[:2]
    blob = cv2.dnn.blobFromImage(
        cv2.resize(frame, (300, 300)),
        scalefactor=0.007843,
        size=(300, 300),
        mean=127.5,
    )
    net.setInput(blob)
    detections = net.forward()
    results: list[tuple[str, float, tuple[int, int, int, int]]] = []

    for i in range(detections.shape[2]):
        confidence = float(detections[0, 0, i, 2])
        if confidence < conf_threshold:
            continue
        class_idx = int(detections[0, 0, i, 1])
        if class_idx < 0 or class_idx >= len(CLASS_NAMES):
            continue
        box = detections[0, 0, i, 3:7] * [width, height, width, height]
        x1, y1, x2, y2 = box.astype("int")
        label = CLASS_NAMES[class_idx]
        results.append((label, confidence, (x1, y1, x2, y2)))
    return results


def parse_grounding_dino_output(output: object) -> list[tuple[str, float, tuple[int, int, int, int]]]:
    """Normalize Replicate Grounding DINO output to (label, confidence, bbox)."""
    if output is None:
        return []

    if isinstance(output, dict):
        candidates = None
        for key in ("detections", "predictions", "boxes", "results", "output"):
            if key in output and isinstance(output[key], list):
                candidates = output[key]
                break
        if candidates is None:
            candidates = [output]
    elif isinstance(output, list):
        candidates = output
    else:
        return []

    parsed: list[tuple[str, float, tuple[int, int, int, int]]] = []
    for item in candidates:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or item.get("class") or item.get("text") or "unknown")
        confidence = float(item.get("confidence") or item.get("score") or item.get("logit") or 0.0)

        box = item.get("box") or item.get("bbox") or item.get("bounding_box") or item.get("xyxy")
        if isinstance(box, dict):
            x1 = int(box.get("xmin", box.get("x", 0)))
            y1 = int(box.get("ymin", box.get("y", 0)))
            x2 = int(box.get("xmax", box.get("x2", x1)))
            y2 = int(box.get("ymax", box.get("y2", y1)))
        elif isinstance(box, (list, tuple)) and len(box) >= 4:
            x1, y1, x2, y2 = (int(box[0]), int(box[1]), int(box[2]), int(box[3]))
        else:
            continue
        parsed.append((label, confidence, (x1, y1, x2, y2)))
    return parsed


async def _detect_objects_grounding_dino(
    frame,
    *,
    query: str,
    model: str,
    box_threshold: float,
    text_threshold: float,
) -> list[tuple[str, float, tuple[int, int, int, int]]]:
    try:
        import replicate
    except Exception as exc:  # pragma: no cover - import path depends on optional dep
        raise RuntimeError("replicate package is required for grounding_dino backend") from exc

    ok, encoded = cv2.imencode(".jpg", frame)
    if not ok:
        return []

    with NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        frame_path = Path(tmp.name)
        frame_path.write_bytes(encoded.tobytes())

    max_retries = 5
    backoff = 2.0
    last_err: Exception | None = None
    try:
        for attempt in range(max_retries):
            try:
                with frame_path.open("rb") as image_handle:
                    output = await replicate.async_run(
                        model,
                        input={
                            "image": image_handle,
                            "query": query,
                            "box_threshold": box_threshold,
                            "text_threshold": text_threshold,
                        },
                    )
                return parse_grounding_dino_output(output)
            except Exception as exc:
                last_err = exc
                err_str = str(exc).lower()
                if "429" in err_str or "throttle" in err_str or "rate" in err_str:
                    wait = backoff * (2 ** attempt)
                    await asyncio.sleep(wait)
                else:
                    raise
        raise RuntimeError(f"Replicate call failed after {max_retries} retries") from last_err
    finally:
        frame_path.unlink(missing_ok=True)


def _iou(box_a: tuple[int, int, int, int], box_b: tuple[int, int, int, int]) -> float:
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    inter_x1 = max(ax1, bx1)
    inter_y1 = max(ay1, by1)
    inter_x2 = min(ax2, bx2)
    inter_y2 = min(ay2, by2)
    inter_w = max(0, inter_x2 - inter_x1)
    inter_h = max(0, inter_y2 - inter_y1)
    inter_area = inter_w * inter_h
    if inter_area == 0:
        return 0.0
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter_area
    return inter_area / union if union > 0 else 0.0


def _track_unique_objects(
    frames_detections: list[list[tuple[str, float, tuple[int, int, int, int]]]],
    max_missed_frames: int = 3,
    iou_threshold: float = 0.25,
    min_confidence: float = 0.0,
    min_hits: int = 1,
) -> tuple[Counter[str], dict[str, dict[int, tuple[str, tuple[int, int, int, int]]]]]:
    """Track objects across frames using IoU matching.

    Args:
        min_confidence: detections below this are ignored for tracking/counting.
        min_hits: a track must be matched in at least this many frames to count
                  as a confirmed unique object (reduces single-frame false positives).
    """
    active_tracks: dict[str, dict[int, dict[str, object]]] = {}
    track_hit_counts: dict[int, int] = {}
    total_unique: Counter[str] = Counter()
    frame_track_boxes: dict[str, dict[int, tuple[str, tuple[int, int, int, int]]]] = {}
    next_track_id = 1

    for frame_dets in frames_detections:
        for tracks in active_tracks.values():
            for state in tracks.values():
                state["missed"] = int(state["missed"]) + 1

        frame_assignments: dict[int, tuple[str, tuple[int, int, int, int]]] = {}

        for label, conf, box in frame_dets:
            if conf < min_confidence:
                continue

            label_tracks = active_tracks.setdefault(label, {})
            best_track_id: int | None = None
            best_iou = 0.0
            for track_id, state in label_tracks.items():
                score = _iou(box, state["bbox"])  # type: ignore[arg-type]
                if score > best_iou:
                    best_iou = score
                    best_track_id = track_id

            if best_track_id is not None and best_iou >= iou_threshold:
                label_tracks[best_track_id]["bbox"] = box
                label_tracks[best_track_id]["missed"] = 0
                track_hit_counts[best_track_id] = track_hit_counts.get(best_track_id, 0) + 1
                frame_assignments[best_track_id] = (label, box)
            else:
                track_id = next_track_id
                next_track_id += 1
                label_tracks[track_id] = {"bbox": box, "missed": 0}
                track_hit_counts[track_id] = 1
                total_unique[label] += 1
                frame_assignments[track_id] = (label, box)

        for label, tracks in list(active_tracks.items()):
            stale = [
                track_id
                for track_id, state in tracks.items()
                if int(state["missed"]) > max_missed_frames
            ]
            for track_id in stale:
                del tracks[track_id]
            if not tracks:
                del active_tracks[label]

        frame_track_boxes[str(len(frame_track_boxes))] = frame_assignments

    if min_hits > 1:
        confirmed: Counter[str] = Counter()
        for label in total_unique:
            count = sum(
                1
                for tid, hits in track_hit_counts.items()
                if hits >= min_hits
                and any(
                    tid in fb and fb[tid][0] == label
                    for fb in frame_track_boxes.values()
                )
            )
            if count > 0:
                confirmed[label] = count
        return confirmed, frame_track_boxes

    return total_unique, frame_track_boxes


def summarize_video_objects(
    video_path: Path,
    sample_every_n_frames: int = 24,
    max_frames: int = 480,
) -> DetectionSummary:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"Unable to open video: {video_path}")

    per_frame_counts: Counter[str] = Counter()
    sampled_detections: list[list[tuple[str, float, tuple[int, int, int, int]]]] = []
    sampled = 0
    frame_idx = 0
    try:
        while cap.isOpened() and sampled < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % sample_every_n_frames == 0:
                detections = detect_objects_in_frame(frame)
                sampled_detections.append(detections)
                for label, _conf, _box in detections:
                    per_frame_counts[label] += 1
                sampled += 1
            frame_idx += 1
    finally:
        cap.release()

    unique_counts, _ = _track_unique_objects(sampled_detections, min_confidence=0.4)
    return DetectionSummary(
        labels=unique_counts,
        unique_labels=unique_counts,
        frame_detection_labels=per_frame_counts,
        frames_sampled=sampled,
    )


async def summarize_video_objects_grounding_dino(
    video_path: Path,
    query: str,
    *,
    model: str = "adirik/grounding-dino",
    box_threshold: float = 0.35,
    text_threshold: float = 0.25,
    sample_every_n_frames: int = 180,
    max_frames: int = 30,
    concurrency: int = 1,
) -> DetectionSummary:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"Unable to open video: {video_path}")

    sampled_frames: list = []
    frame_idx = 0
    try:
        while cap.isOpened() and len(sampled_frames) < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % sample_every_n_frames == 0:
                sampled_frames.append(frame.copy())
            frame_idx += 1
    finally:
        cap.release()

    semaphore = asyncio.Semaphore(concurrency)

    async def _detect(frame):
        async with semaphore:
            return await _detect_objects_grounding_dino(
                frame,
                query=query,
                model=model,
                box_threshold=box_threshold,
                text_threshold=text_threshold,
            )

    detections_per_frame = await asyncio.gather(*[_detect(frame) for frame in sampled_frames])

    per_frame_counts: Counter[str] = Counter()
    for detections in detections_per_frame:
        for label, _confidence, _bbox in detections:
            per_frame_counts[label] += 1

    unique_counts, _ = _track_unique_objects(
        detections_per_frame,
        min_confidence=box_threshold,
        min_hits=1,
    )
    return DetectionSummary(
        labels=unique_counts,
        unique_labels=unique_counts,
        frame_detection_labels=per_frame_counts,
        frames_sampled=len(sampled_frames),
    )


def annotate_video(
    input_video: Path,
    output_video: Path,
    sample_every_n_frames: int = 12,
    max_frames: int = 600,
    persist_frames: int = 12,
) -> Path:
    cap = cv2.VideoCapture(str(input_video))
    if not cap.isOpened():
        raise ValueError(f"Unable to open video: {input_video}")

    output_video.parent.mkdir(parents=True, exist_ok=True)

    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    writer = cv2.VideoWriter(
        str(output_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )

    sampled_detections: list[list[tuple[str, float, tuple[int, int, int, int]]]] = []
    cached_frames: list = []
    frame_idx = 0
    try:
        while cap.isOpened() and frame_idx < max_frames:
            ok, frame = cap.read()
            if not ok:
                break

            cached_frames.append(frame.copy())
            if frame_idx % sample_every_n_frames == 0:
                sampled_detections.append(detect_objects_in_frame(frame))
            frame_idx += 1

        unique_counts, track_boxes = _track_unique_objects(sampled_detections)

        sampled_idx = 0
        # Keep last known boxes so overlays persist between sampled frames.
        last_seen: dict[int, tuple[str, tuple[int, int, int, int], int]] = {}
        for idx, frame in enumerate(cached_frames):
            if idx % sample_every_n_frames == 0:
                boxes_for_frame = track_boxes.get(str(sampled_idx), {})
                for track_id, (label, bbox) in boxes_for_frame.items():
                    last_seen[track_id] = (label, bbox, idx)
                cv2.putText(
                    frame,
                    "unique: " + ", ".join(f"{k}:{v}" for k, v in unique_counts.most_common(4)),
                    (20, 40),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.7,
                    (255, 255, 0),
                    2,
                )
                sampled_idx += 1

            # Draw tracks for current frame, persisting stale boxes briefly.
            expired: list[int] = []
            for track_id, (label, (x1, y1, x2, y2), seen_idx) in last_seen.items():
                if idx - seen_idx > persist_frames:
                    expired.append(track_id)
                    continue
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(
                    frame,
                    f"{label}#{track_id}",
                    (x1, max(20, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 255, 0),
                    2,
                )
            for track_id in expired:
                del last_seen[track_id]
            writer.write(frame)
    finally:
        cap.release()
        writer.release()

    return output_video


def most_common_labels(labels: Counter[str], top_n: int = 8) -> Iterable[tuple[str, int]]:
    return labels.most_common(top_n)


async def annotate_video_grounding_dino(
    input_video: Path,
    output_video: Path,
    query: str,
    *,
    model: str = "adirik/grounding-dino:efd10a8ddc57ea28773327e881ce95e20cc1d734c589f7dd01d2036921ed78aa",
    box_threshold: float = 0.35,
    text_threshold: float = 0.25,
    sample_every_n_frames: int = 180,
    max_frames: int = 600,
    persist_frames: int = 180,
) -> Path:
    """Render Grounding DINO detections as an annotated video overlay."""
    cap = cv2.VideoCapture(str(input_video))
    if not cap.isOpened():
        raise ValueError(f"Unable to open video: {input_video}")

    output_video.parent.mkdir(parents=True, exist_ok=True)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    writer = cv2.VideoWriter(
        str(output_video),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )

    sampled_frames: list = []
    cached_frames: list = []
    frame_idx = 0
    try:
        while cap.isOpened() and frame_idx < max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            cached_frames.append(frame.copy())
            if frame_idx % sample_every_n_frames == 0:
                sampled_frames.append(frame.copy())
            frame_idx += 1
    finally:
        cap.release()

    detections_per_sample: list[list[tuple[str, float, tuple[int, int, int, int]]]] = []
    for frame in sampled_frames:
        detections = await _detect_objects_grounding_dino(
            frame,
            query=query,
            model=model,
            box_threshold=box_threshold,
            text_threshold=text_threshold,
        )
        detections_per_sample.append(detections)

    unique_counts, track_boxes = _track_unique_objects(
        detections_per_sample,
        min_confidence=box_threshold,
    )

    sampled_idx = 0
    last_seen: dict[int, tuple[str, tuple[int, int, int, int], int]] = {}
    for idx, frame in enumerate(cached_frames):
        if idx % sample_every_n_frames == 0 and sampled_idx < len(detections_per_sample):
            boxes_for_frame = track_boxes.get(str(sampled_idx), {})
            for track_id, (label, bbox) in boxes_for_frame.items():
                last_seen[track_id] = (label, bbox, idx)
            sampled_idx += 1

        expired: list[int] = []
        for track_id, (label, (x1, y1, x2, y2), seen_at) in last_seen.items():
            if idx - seen_at > persist_frames:
                expired.append(track_id)
                continue
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 200, 255), 2)
            cv2.putText(
                frame,
                f"{label}#{track_id}",
                (x1, max(20, y1 - 8)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 200, 255),
                2,
            )
        for track_id in expired:
            del last_seen[track_id]

        summary_text = "unique: " + ", ".join(f"{k}:{v}" for k, v in unique_counts.most_common(4))
        cv2.putText(
            frame,
            summary_text,
            (20, 40),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 0),
            2,
        )
        writer.write(frame)

    writer.release()
    return output_video
