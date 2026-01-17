---
'@thaumic-cast/server': minor
---

Introduce standalone headless server

**New Application**

Add `apps/server` - a headless Thaumic Cast server that runs without a GUI. Built on thaumic-core, it provides the same streaming capabilities as the desktop app for server/NAS deployments.

**Features**

- YAML configuration file support (`config.yaml`)
- CLI arguments for host, port, data directory
- Environment variable overrides (`THAUMIC_HOST`, `THAUMIC_PORT`, etc.)
- Graceful shutdown on SIGINT/SIGTERM
- Optional data persistence directory for manual speakers

**Configuration Precedence**

CLI args > Environment variables > Config file > Defaults

**Usage**

```bash
# With config file
thaumic-server --config config.yaml

# With CLI args
thaumic-server --host 0.0.0.0 --port 9876

# With environment
THAUMIC_PORT=9876 thaumic-server
```
