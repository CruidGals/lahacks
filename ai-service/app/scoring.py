"""Final scoring + verification decision."""

from __future__ import annotations

from app.config import Settings
from app.fraud import FraudReport
from app.models import SceneMatchResult, TaskCompleteResult, VerificationResult


SCENE_WEIGHT = 0.5
TASK_WEIGHT = 0.5


def combined_confidence(scene: SceneMatchResult, task: TaskCompleteResult) -> float:
    return SCENE_WEIGHT * scene.confidence + TASK_WEIGHT * task.confidence


def decide(
    scene: SceneMatchResult,
    task: TaskCompleteResult,
    fraud: FraudReport,
    settings: Settings,
) -> VerificationResult:
    """Combine vision + fraud signals into the final response payload."""

    confidence = combined_confidence(scene, task)
    verified = (
        confidence > settings.verification_confidence_threshold
        and scene.same_location
        and task.task_complete
        and not fraud.flags
    )

    reasoning = _build_reasoning(scene, task, fraud, confidence, verified, settings)
    final_result = (
        "Task has been successfully completed and artifact was removed."
        if verified
        else "Task verification failed or artifact is still present."
    )

    return VerificationResult(
        verified=verified,
        final_result=final_result,
        artifact_removed=task.artifact_removed,
        confidence=round(confidence, 4),
        scene_match=scene.same_location,
        task_complete=task.task_complete,
        fraud_flags=list(fraud.flags),
        reasoning=reasoning,
    )


def _build_reasoning(
    scene: SceneMatchResult,
    task: TaskCompleteResult,
    fraud: FraudReport,
    confidence: float,
    verified: bool,
    settings: Settings,
) -> str:
    parts: list[str] = []
    parts.append(
        f"scene_match={scene.same_location} (conf={scene.confidence:.2f}); "
        f"task_complete={task.task_complete} (conf={task.confidence:.2f}); "
        f"combined={confidence:.2f} threshold={settings.verification_confidence_threshold:.2f}"
    )
    if fraud.flags:
        parts.append("fraud_flags=" + ",".join(fraud.flags))
    if fraud.notes:
        parts.append("notes=" + " | ".join(fraud.notes))
    parts.append("verified=true" if verified else "verified=false")
    return "; ".join(parts)
