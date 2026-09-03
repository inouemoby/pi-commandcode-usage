# pi-commandcode-usage

Command Code usage and quota monitor for Pi.

Displays 5-hour and weekly rolling limits, remaining credits, and reset times in the footer when using the Command Code provider.

## Features

- Footer display for 5-hour and weekly usage
- `/commandcode` command to view quota details
- `commandcode_usage` tool for the agent
- Automatic idle refresh

## Authentication

Reads the Command Code API key from:
- `COMMAND_CODE_API_KEY` environment variable
- `~/.pi/agent/auth.json` (`commandcode`)

## Install

```bash
pi install git:github.com/inouemoby/pi-commandcode-usage
```
