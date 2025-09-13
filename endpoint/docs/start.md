# --- 0) VM settings (edit if your IP/user changes)
$env:VM_USER = "dudesoup"
$env:VM_IP   = "34.145.237.188"
$vm  = "$($env:VM_USER)@$($env:VM_IP)"
$key = "$HOME\.ssh\id_ed25519"

# --- 1) Safe remote runner to avoid quoting headaches
function VM-Run {
  param([Parameter(Mandatory=$true)][string]$Cmd)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Cmd))
  ssh -i "$key" "$vm" "echo $b64 | base64 -d | bash"
}

# --- 2) Handy helpers
function VM-Status     { VM-Run 'systemctl status --no-pager -l sol-follower || true' }
function VM-Logs       { VM-Run 'tail -n 200 ~/endpoint/logs/validator.log || echo no-log' }
function VM-LogsFollow { ssh -t -i "$key" "$vm" 'tail -f ~/endpoint/logs/validator.log' }
function VM-RPCCheck   { VM-Run 'ss -ltnp | grep 127.0.0.1:8899 || echo RPC-not-listening-yet' }
function VM-Restart    { VM-Run 'sudo systemctl restart sol-follower; sleep 1; systemctl is-active sol-follower && echo restarted' }

# --- 3) Wait for RPC to be up on the VM, then open a local tunnel
function Start-RPCTunnel {
  param([int]$LocalPort = 8899)

  Write-Host "Waiting for RPC on VM (127.0.0.1:8899)..." -ForegroundColor Yellow
  while ($true) {
    $ready = VM-Run 'if ss -ltnp | grep -q "127.0.0.1:8899"; then echo READY; else echo NOTYET; fi'
    if ($ready -match 'READY') { break }
    Start-Sleep 10
  }
  Write-Host "RPC is up. Opening local tunnel localhost:$LocalPort -> VM:127.0.0.1:8899" -ForegroundColor Green

  # Start SSH tunnel in its own minimized window so it doesn’t spam this one
  Start-Process -WindowStyle Minimized -FilePath ssh.exe -ArgumentList @(
    '-NT',
    '-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=30',
    '-o','ServerAliveCountMax=3',
    '-i',"$key",
    '-L',"$LocalPort:127.0.0.1:8899",
    "$vm"
  )
  Write-Host "Tunnel started (minimized). Test RPC calls below." -ForegroundColor Green
}

# --- 4) Quick sanity check & current status
Write-Host "Using key: $key"; if (-not (Test-Path $key)) { throw "SSH key not found: $key" }
ssh -i "$key" "$vm" 'echo "connected as: $(whoami) on $(hostname)"'
VM-Status


