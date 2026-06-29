local config = require('peek.config')

local chansend = vim.fn.chansend
local concat = table.concat
local tbl_map = vim.tbl_map

local module = {}

local cwd = debug.getinfo(1, 'S').source:sub(2):match('(.*[/\\])')
local log_path =
  string.format('%s%speek-lua.log', vim.fn.stdpath('log'), vim.loop.os_uname().sysname:match('Windows') and '\\' or '/')
local cmd, channel, on_exit_callback

local function log(msg)
  local line = string.format('%s pid=%s %s', os.date('%Y-%m-%d %H:%M:%S'), vim.fn.getpid(), msg)
  pcall(vim.fn.writefile, { line }, log_path, 'a')
end

local function lentouint32(str)
  local len = string.len(str)
  local t = {}
  for i = 4, 1, -1 do
    t[i] = math.fmod(len, 256)
    len = math.floor((len - t[i]) / 256)
  end
  return string.char(unpack(t))
end

local function message(chunks)
  return concat(tbl_map(function(chunk)
    return lentouint32(chunk) .. chunk
  end, chunks))
end

local function ssh_port()
  return config.get('ssh_port') or config.get('port')
end

local function git_repo_name(path)
  local result = vim.system({ 'git', '-C', path, 'rev-parse', '--show-toplevel' }, { text = true }):wait()
  if result.code ~= 0 then
    return vim.fn.fnamemodify(path, ':t')
  end

  return vim.fn.fnamemodify(vim.trim(result.stdout), ':t')
end

function module.setup()
  local sep = vim.loop.os_uname().sysname:match('Windows') and '\\' or '/'
  local args = {
    '--logfile=' .. string.format('%s%speek.log', vim.fn.stdpath('log'), sep),
    '--theme=' .. config.get('theme'),
    '--app=' .. vim.json.encode(config.get('app')),
  }

  if config.get('syntax') then
    table.insert(args, '--syntax')
  end

  if config.get('app') == 'ssh' then
    table.insert(args, '--port=' .. ssh_port())
  end

  cmd = vim.list_extend({
    'deno',
    'task',
    '--quiet',
    'run',
  }, args)

  log(
    'setup app='
      .. vim.inspect(config.get('app'))
      .. ' port='
      .. tostring(config.get('port'))
      .. ' ssh_port='
      .. tostring(config.get('ssh_port'))
      .. ' effective_ssh_port='
      .. tostring(ssh_port())
      .. ' cmd='
      .. table.concat(cmd, ' ')
  )
end

function module.init(on_exit)
  if channel then
    log('init skipped existing channel=' .. tostring(channel))
    return
  end

  on_exit_callback = on_exit
  log('init starting app=' .. vim.inspect(config.get('app')))

  if config.get('app') == 'ssh' then
    local port = ssh_port()
    vim.system({ 'sh', '-c', 'printf "%s@%s" "$(whoami)" "$(hostname)"' }, { text = true }, function(result)
      local user_host = vim.trim(result.stdout)
      local ssh_command = string.format('ssh -L %d:localhost:%d %s', port, port, user_host)
      vim.schedule(function()
        vim.fn.setreg('+', ssh_command)
        vim.notify('Peek: ssh port copied', vim.log.levels.INFO, {})
        log('ssh command copied: ' .. ssh_command)
      end)
    end)
  end

  channel = vim.fn.jobstart(cmd, {
    cwd = cwd,
    stderr_buffered = true,
    on_stderr = function(_, err)
      log('stderr received channel=' .. tostring(channel) .. ' lines=' .. tostring(#err))
      vim.fn.jobstop(channel)
      local content = table.concat(err, '\n'):gsub('\27[[0-9;]*m', '')
      if content:len() > 0 then
        if content:match("assertion 'main_loops != NULL' failed") then
          return
        end
        vim.api.nvim_notify('Peek error: ' .. content, vim.log.levels.ERROR, {})
      end
    end,
    detach = config.get('app') == 'ssh',
    on_exit = function(_, code, event)
      log('job exit channel=' .. tostring(channel) .. ' code=' .. tostring(code) .. ' event=' .. tostring(event))
      if channel then
        vim.fn.chanclose(channel)
        channel = nil
      end
      if on_exit_callback then
        local callback = on_exit_callback
        on_exit_callback = nil
        callback()
      end
    end,
  })

  log('job started channel=' .. tostring(channel))
  if channel <= 0 then
    vim.api.nvim_notify('Peek error: failed to start deno job', vim.log.levels.ERROR, {})
    return
  end

  module.show = function(content)
    log('send show channel=' .. tostring(channel) .. ' bytes=' .. tostring(#content))
    chansend(channel, message({ 'show', content }))
  end

  module.scroll = function(line)
    log('send scroll channel=' .. tostring(channel) .. ' line=' .. tostring(line))
    chansend(channel, message({ 'scroll', line }))
  end

  module.base = function(path)
    local label = git_repo_name(path)
    log('send base channel=' .. tostring(channel) .. ' path=' .. tostring(path))
    chansend(channel, message({ 'base', path }))
    log('send label channel=' .. tostring(channel) .. ' label=' .. tostring(label))
    chansend(channel, message({ 'label', label }))
  end
end

module.stop = function()
  if not channel then
    log('stop skipped no channel')
    return
  end

  log('stop channel=' .. tostring(channel) .. ' app=' .. vim.inspect(config.get('app')))

  if config.get('app') == 'ssh' then
    log('send close channel=' .. tostring(channel))
    chansend(channel, message({ 'close' }))
    vim.fn.chanclose(channel, 'stdin')
    channel = nil
    if on_exit_callback then
      local callback = on_exit_callback
      on_exit_callback = nil
      callback()
    end
    return
  end

  vim.fn.jobstop(channel)
end

return module
