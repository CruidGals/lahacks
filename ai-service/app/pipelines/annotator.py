"""Draw DINO bounding boxes on extracted frames using PIL.

Two callers use this:

* The pipelines, to feed the LLM annotated frames so labels + locations are
  unambiguous in-image (better than asking the model to visually parse raw
  detections from coordinates).
* The hackathon demo UI, which displays the same annotated frames to the
  poster so they can see what the detector found.

Both callers want JPEGs as base64 strings, so that's what we return.
"""

from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from app.pipelines.dino_types import Detection, FrameDetections
from app.pipelines.frame_extractor import ExtractedFrame

# Per-label color palette. We hash the label so the same trash type always
# gets the same color across frames, which makes side-by-side reference vs
# submission frames easier for the LLM to compare.
_PALETTE = [
    (255, 99, 71),
    (60, 179, 113),
    (65, 105, 225),
    (255, 165, 0),
    (218, 112, 214),
    (32, 178, 170),
    (255, 215, 0),
    (199, 21, 133),
]


def _color_for_label(label: str) -> tuple[int, int, int]:
    return _PALETTE[hash(label) % len(_PALETTE)]


def _load_font() -> ImageFont.ImageFont:
    # ImageFont.truetype isn't guaranteed across platforms; default font is
    # always available and good enough for demo overlays.
    try:
        return ImageFont.truetype("arial.ttf", 16)
    except OSError:
        return ImageFont.load_default()


def _bgr_to_pil(image_bgr: np.ndarray) -> Image.Image:
    rgb = image_bgr[:, :, ::-1]  # OpenCV uses BGR; PIL wants RGB.
    return Image.fromarray(rgb)


def _pil_to_jpeg_b64(image: Image.Image, *, quality: int = 85) -> str:
    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=quality)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def annotate_frame(
    frame: ExtractedFrame,
    detections: list[Detection],
) -> ExtractedFrame:
    """Return a new ``ExtractedFrame`` with bounding boxes burned in.

    The original frame is left untouched (PIL works on a copy). When there
    are no detections we still return a copy so downstream code can treat all
    frames uniformly.
    """

    image = _bgr_to_pil(frame.image_bgr).copy()
    draw = ImageDraw.Draw(image)
    font = _load_font()

    for detection in detections:
        x1 = max(0, int(detection.bbox.x))
        y1 = max(0, int(detection.bbox.y))
        x2 = min(image.width, int(detection.bbox.x + detection.bbox.w))
        y2 = min(image.height, int(detection.bbox.y + detection.bbox.h))
        if x2 <= x1 or y2 <= y1:
            continue
        color = _color_for_label(detection.label)
        draw.rectangle([(x1, y1), (x2, y2)], outline=color, width=3)

        caption = f"{detection.label} {detection.confidence:.2f}"
        text_y = max(0, y1 - 18)
        # Solid background behind the caption so it stays legible on busy
        # scenes (PIL has no built-in stroked text on default font).
        text_bbox = draw.textbbox((x1, text_y), caption, font=font)
        draw.rectangle(text_bbox, fill=color)
        draw.text((x1, text_y), caption, fill=(255, 255, 255), font=font)

    new_b64 = _pil_to_jpeg_b64(image)
    rgb_array = np.asarray(image.convert("RGB"))
    new_bgr = rgb_array[:, :, ::-1].copy()  # back to BGR for downstream consumers
    return ExtractedFrame(
        timestamp_s=frame.timestamp_s,
        frame_index=frame.frame_index,
        image_bgr=new_bgr,
        jpeg_b64=new_b64,
        width=image.width,
        height=image.height,
    )


def annotate_frames(
    frames: list[ExtractedFrame],
    dino_frames: list[FrameDetections],
) -> list[ExtractedFrame]:
    """Annotate each extracted frame with the closest matching DINO frame.

    Matching strategy: for each extracted frame, pick the DINO frame whose
    ``timestamp_s`` is nearest. This is robust to mismatched frame counts
    (e.g. DINO sampled 10 frames, we extracted 5 for the LLM).
    """

    if not dino_frames:
        return [annotate_frame(frame, []) for frame in frames]

    sorted_dino = sorted(dino_frames, key=lambda d: d.timestamp_s)
    annotated: list[ExtractedFrame] = []
    for frame in frames:
        nearest = min(sorted_dino, key=lambda d: abs(d.timestamp_s - frame.timestamp_s))
        annotated.append(annotate_frame(frame, nearest.detections))
    return annotated
