"""Video object detection helpers for cleanup verification."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
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
) -> tuple[Counter[str], dict[str, dict[int, tuple[str, tuple[int, int, int, int]]]]]:
    # active tracks grouped by label; each track stores last bbox + miss count.
    active_tracks: dict[str, dict[int, dict[str, object]]] = {}
    total_unique: Counter[str] = Counter()
    # frame index -> track_id -> bbox map for optional rendering.
    frame_track_boxes: dict[str, dict[int, tuple[str, tuple[int, int, int, int]]]] = {}
    next_track_id = 1

    for frame_dets in frames_detections:
        # increment miss counters; matched tracks will be reset.
        for tracks in active_tracks.values():
            for state in tracks.values():
                state["missed"] = int(state["missed"]) + 1

        frame_assignments: dict[int, tuple[str, tuple[int, int, int, int]]] = {}

        for label, _conf, box in frame_dets:
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
                frame_assignments[best_track_id] = (label, box)
            else:
                track_id = next_track_id
                next_track_id += 1
                label_tracks[track_id] = {"bbox": box, "missed": 0}
                total_unique[label] += 1
                frame_assignments[track_id] = (label, box)

        # prune stale tracks
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

    unique_counts, _ = _track_unique_objects(sampled_detections)
    return DetectionSummary(
        labels=unique_counts,
        unique_labels=unique_counts,
        frame_detection_labels=per_frame_counts,
        frames_sampled=sampled,
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
