from app.fraud import FraudReport
from app.models import SceneMatchResult, TaskCompleteResult
from app.scoring import combined_confidence, decide


def _scene(ok=True, conf=0.9):
    return SceneMatchResult(same_location=ok, matching_features=[], confidence=conf)


def _task(ok=True, conf=0.9):
    return TaskCompleteResult(
        task_complete=ok,
        artifact_removed=ok,
        items=[],
        confidence=conf,
    )


def test_combined_confidence_is_weighted_average():
    assert combined_confidence(_scene(conf=0.9), _task(conf=0.7)) == 0.8


def test_decide_verified_true_when_all_pass(settings):
    out = decide(_scene(conf=0.9), _task(conf=0.9), FraudReport(flags=[], notes=[]), settings)
    assert out.verified is True
    assert out.final_result == "Task has been successfully completed and artifact was removed."
    assert out.artifact_removed is True
    assert out.confidence == 0.9
    assert out.scene_match is True
    assert out.task_complete is True


def test_decide_blocked_by_low_confidence(settings):
    out = decide(_scene(conf=0.7), _task(conf=0.7), FraudReport(flags=[], notes=[]), settings)
    assert out.verified is False


def test_decide_blocked_by_fraud_flag(settings):
    out = decide(
        _scene(conf=0.9),
        _task(conf=0.9),
        FraudReport(flags=["session_too_short"], notes=[]),
        settings,
    )
    assert out.verified is False
    assert "session_too_short" in out.fraud_flags


def test_decide_blocked_by_scene_false(settings):
    out = decide(_scene(ok=False, conf=0.9), _task(conf=0.9), FraudReport(flags=[], notes=[]), settings)
    assert out.verified is False
    assert out.scene_match is False


def test_decide_blocked_by_task_false(settings):
    out = decide(_scene(conf=0.9), _task(ok=False, conf=0.9), FraudReport(flags=[], notes=[]), settings)
    assert out.verified is False
    assert out.artifact_removed is False
    assert out.task_complete is False
