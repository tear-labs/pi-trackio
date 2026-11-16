import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("run_lifecycle", Path(__file__).parents[1] / "tools/run-lifecycle.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class JobStatusTests(unittest.TestCase):
    def resolve(self, record=None, app=None, provider_ok=True, **target):
        target = {"run_id": "id", "run_name": "run-1", "app_id": "ap-test", **target}
        return module.resolve_status(target, record, {"ap-test": app} if app else {},
                                     provider_ok=provider_ok, checked_at="now")

    def test_final_worker_record_beats_stopped_app(self):
        result = self.resolve({"plan": {"run_id": "run-1"}, "status": "completed"}, {"state": "stopped"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["source"], "worker run.json")

    def test_running_needs_a_live_provider_worker(self):
        self.assertEqual(self.resolve(app={"state": "ephemeral (detached)", "tasks": "1"})["status"], "running")
        self.assertEqual(self.resolve(app={"state": "ephemeral (detached)", "tasks": "0"})["status"], "idle")

    def test_killed_worker_is_not_invented_as_success(self):
        result = self.resolve({"plan": {"run_id": "run-1"}, "status": "running"}, {"state": "stopped"})
        self.assertEqual(result["status"], "stopped")

    def test_unreachable_or_missing_provider_is_unknown(self):
        record = {"plan": {"run_id": "run-1"}, "status": "running"}
        self.assertEqual(self.resolve(record, provider_ok=False)["status"], "unknown")
        self.assertEqual(self.resolve(record)["status"], "unknown")

    def test_wrong_run_or_commit_is_not_attributed(self):
        record = {"plan": {"run_id": "other"}, "status": "completed"}
        self.assertEqual(self.resolve(record)["status"], "unknown")
        record["plan"]["run_id"] = "run-1"
        record["provenance"] = {"commit": "wrong"}
        self.assertEqual(self.resolve(record, commit="expected")["status"], "unknown")

    def test_config_status_is_explicitly_reported(self):
        result = self.resolve(reported_status="failed", provider_ok=False)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["source"], "Trackio config (reported)")


if __name__ == "__main__":
    unittest.main()
