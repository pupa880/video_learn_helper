"""配置加载不得改写 DEFAULT_CONFIG。"""

from app import config as app_config
from app import state


def test_load_config_does_not_mutate_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(app_config, "CONFIG_PATH", tmp_path / "missing.json")
    app_config._config = None
    before = app_config.DEFAULT_CONFIG["llm"]["provider"]
    cfg = app_config.load_config()
    cfg["llm"]["provider"] = "__mutated__"
    assert app_config.DEFAULT_CONFIG["llm"]["provider"] == before
    app_config._config = None


def test_invalid_video_id_rejected():
    try:
        state.video_dir("../etc")
        assert False, "should reject path traversal"
    except state.InvalidVideoId:
        pass
    try:
        state.load_meta("not-a-hex-id")
        assert False, "should reject non-hex id"
    except state.InvalidVideoId:
        pass
