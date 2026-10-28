local module = {}

local query = [[
try {
  const response = await fetch(`http://127.0.0.1:${Deno.args[0]}/__peek/status`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const status = await response.json();
  if (status.service !== 'peek.nvim') throw new Error('Not a Peek server');
  console.log(JSON.stringify(status));
} catch (error) {
  console.error(error.message);
  Deno.exit(1);
}
]]

function module.show(port, app)
  if not port then
    vim.notify('Peek status\nServer: not running (open a preview first)', vim.log.levels.INFO)
    return
  end

  vim.system({ 'deno', 'eval', query, tostring(port) }, { text = true }, function(result)
    vim.schedule(function()
      if result.code ~= 0 then
        vim.notify(
          string.format('Peek status\nServer: unreachable on port %d\n%s', port, vim.trim(result.stderr)),
          vim.log.levels.WARN
        )
        return
      end

      local ok, status = pcall(vim.json.decode, result.stdout)
      if not ok then
        vim.notify('Peek status: invalid server response', vim.log.levels.ERROR)
        return
      end

      local buffers = 0
      local attached = false
      for _, connection in ipairs(status.connections) do
        if connection.context then
          buffers = buffers + 1
          attached = attached or connection.context.pid == vim.fn.getpid()
        end
      end

      local lines = {
        'Peek status',
        string.format('Server: healthy (PID %d)', status.pid),
        string.format('Mode: %s', type(status.app) == 'table' and table.concat(status.app, ' ') or status.app),
        string.format('Listening: %s:%d', status.hostname, status.port),
        string.format('Neovim connections: %d', #status.connections),
        string.format('This Neovim: %s', attached and 'connected' or 'not attached'),
        string.format('Browser/webview connections: %d', status.viewers),
        string.format('Active preview buffers: %d', buffers),
      }
      for _, connection in ipairs(status.connections) do
        local context = connection.context
        if context then
          table.insert(
            lines,
            string.format(
              '  %s — Neovim PID %d, buffer %d: %s',
              connection.label,
              context.pid,
              context.buffer.number,
              context.buffer.name ~= '' and context.buffer.name or '[No Name]'
            )
          )
        else
          table.insert(lines, '  ' .. connection.label .. ' — waiting for buffer information')
        end
      end
      table.insert(lines, app == 'webview' and 'Server status URLs:' or 'Preview URLs:')
      for _, url in ipairs(status.urls) do
        table.insert(lines, '  ' .. url .. (app == 'webview' and '/__peek/status' or ''))
      end
      if app == 'ssh' then
        table.insert(lines, 'Loopback URL requires SSH forwarding when accessed remotely.')
      end
      vim.notify(table.concat(lines, '\n'), vim.log.levels.INFO, { title = 'Peek status' })
    end)
  end)
end

return module
