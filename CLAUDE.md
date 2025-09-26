# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

peek.nvim is a Neovim plugin that provides live markdown preview with GitHub-style rendering. It consists of:

- **Lua plugin** (lua/peek/): Neovim integration layer that manages preview lifecycle and buffer synchronization
- **Deno app** (app/src/): TypeScript backend server that handles markdown rendering and WebSocket communication
- **Client** (client/src/): TypeScript frontend that displays the rendered markdown

## Key Commands

```bash
# Build the project (required after cloning)
deno task build:fast

# Build with live reload for development
deno task build:watch

# Build with debug output
deno task build:debug

# Run the standalone preview server
deno task run

# Format TypeScript code
deno fmt
```

## Architecture

### Communication Flow

1. Neovim (lua/peek/init.lua) spawns Deno process when preview opens
2. Lua sends markdown content to Deno via stdin using a simple protocol:
   - `show` + content: Render markdown
   - `scroll` + line: Sync scroll position
   - `base` + path: Set base path for relative links
3. Deno server (app/src/main.ts) processes markdown and sends HTML to client via WebSocket
4. Client (client/src/script.ts) displays rendered content with synchronized scrolling

### Key Components

**Lua Plugin (lua/peek/)**

- `init.lua`: Main entry point, manages autocmds for buffer updates and cursor tracking
- `app.lua`: Spawns and manages the Deno subprocess
- `config.lua`: Configuration management
- `throttle.lua`: Throttling mechanism for large file updates

**Deno Application (app/src/)**

- `main.ts`: WebSocket server and stdin reader, routes between webview/browser modes
- `markdownit.ts`: Markdown rendering with KaTeX (math) and Mermaid (diagrams) support
- `webview.ts`: Native webview window wrapper (using webview_deno)
- `read.ts`: Stdin chunk reader for IPC with Neovim

**Client (client/src/)**

- `script.ts`: WebSocket client, handles rendered HTML updates and scroll synchronization
- `mermaid.ts`: Mermaid diagram rendering integration

## Development Patterns

The codebase uses:

- Deno for TypeScript runtime and tooling
- WebSocket for real-time communication
- markdown-it with plugins for rendering
- Native webview or browser for display
- Simple text-based IPC protocol between Lua and Deno via stdin/stdout
