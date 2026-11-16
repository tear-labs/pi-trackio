"""Read Modal job state and small run.json records. Never launches or cancels jobs."""
import json
import subprocess
import sys
from datetime import datetime, timezone


TERMINAL = {
    "completed": "completed", "finished": "completed", "succeeded": "completed",
    "failed": "failed", "cancelled": "cancelled", "canceled": "cancelled",
    "paused": "paused", "stopped": "stopped", "timed_out": "failed",
}


def resolve_status(target, record, apps, *, provider_ok, checked_at):
    """A final worker record beats app state; silence never establishes job state."""
    result = {"run_id": target["run_id"], "run_name": target["run_name"],
              "status": "unknown", "source": "unavailable", "checkedAt": checked_at}
    if record is not None:
        identity = record.get("plan", {}).get("run_id") or record.get("run_id")
        commit = record.get("provenance", {}).get("commit")
        if identity != target["run_name"] or (target.get("commit") and commit != target["commit"]):
            return {**result, "detail": "Remote record identity differs from the tracked run."}
        status = TERMINAL.get(record.get("status"))
        if status:
            return {**result, "status": status, "source": "worker run.json",
                    "detail": "Final status recorded by the worker."}
    app_id = (record or {}).get("backend_info", {}).get("app_id") or target.get("app_id")
    if app_id:
        result["app_id"] = app_id
    app = apps.get(app_id) if provider_ok else None
    if app is not None:
        result.update(source="Modal app", providerState=app.get("state"))
        state = str(app.get("state", "")).lower()
        if state == "stopped":
            return {**result, "status": "stopped", "detail": "App stopped; no final worker outcome was recorded."}
        try:
            tasks = int(app.get("tasks", 0))
        except (ValueError, TypeError):
            tasks = 0
        if state.startswith(("ephemeral", "deployed")):
            return {**result, "status": "running" if tasks > 0 else "idle", "tasks": tasks,
                    "detail": "Provider confirms an active worker." if tasks > 0 else "App active, but no worker is allocated (starting, queued, or idle)."}
    reported = TERMINAL.get(target.get("reported_status"))
    if reported:
        return {**result, "status": reported, "source": "Trackio config (reported)",
                "detail": "Explicit status in the tracked run configuration; provider verification unavailable."}
    return {**result, "detail": "Job identity or current provider state could not be verified."}


def main():
    payload = json.load(sys.stdin)
    options, targets = payload["modal"], payload["targets"]
    apps, provider_ok = {}, False
    if any(t.get("path") or t.get("app_id") for t in targets):
        try:
            response = subprocess.run([options["cli"], "app", "list", "--json"],
                                      capture_output=True, text=True, timeout=12, check=True)
            apps = {row["app_id"]: row for row in json.loads(response.stdout)}
            provider_ok = True
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    volume = None
    checked_at = datetime.now(timezone.utc).isoformat()
    results = []
    for target in targets:
        record = None
        if target.get("path"):
            try:
                if volume is None:
                    import modal
                    volume = modal.Volume.from_name(options["runsVolume"])
                chunks, size = [], 0
                for chunk in volume.read_file(target["path"]):
                    size += len(chunk)
                    if size > 2 * 1024 * 1024:
                        raise ValueError("run.json exceeds the metadata size limit")
                    chunks.append(chunk)
                record = json.loads(b"".join(chunks))
            except Exception:
                # An unreadable record is unknown, never evidence of completion.
                pass
        results.append(resolve_status(target, record, apps, provider_ok=provider_ok, checked_at=checked_at))
    print(json.dumps({"runs": results, "providerAvailable": provider_ok}))


if __name__ == "__main__":
    main()
