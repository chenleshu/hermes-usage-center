"""Registration marker for the usage-center user plugin.

The runtime capability is exposed by dashboard/plugin_api.py; this no-op
registration keeps the plugin visible to `hermes plugins` without adding
model tools or lifecycle hooks.
"""


def register(ctx) -> None:
    return None
