# Soak scripts

Two scripts run an overnight test of `--mux` across two devices:

- `mux-termux.sh` — on the **server** device (Termux/Linux): generates a test file,
  starts an isolated p2pgate server (own `HOME`, own keys/password) plus an HTTP
  target, and samples the server's RSS every 5 minutes.
- `mux-windows.ps1` — on the **client** device: runs `p2pgate connect --mux` and,
  every interval, downloads the file through the tunnel and verifies SHA-256.

The isolated `HOME` means your real `~/.p2pgate` is never touched, and both can run
while your normal server keeps working (different ports/secrets).

## 1. Server device

```sh
# Termux: keep Android from suspending the session
termux-wake-lock

mkdir -p ~/soak
# copy scripts/soak/mux-termux.sh and scripts/soak/target-http.js into ~/soak
bash ~/soak/mux-termux.sh 8      # 8 MiB test file, target port 18081
```

It prints `SECRET`, `PASSWORD`, `SHA`, `BYTES` (also saved to
`~/.p2pgate-soak/creds.txt`, mode 0600).

## 2. Client device (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\soak\mux-windows.ps1 `
  -Secret <SECRET> -Password <PASSWORD> `
  -ExpectedSha <SHA> -ExpectedBytes <BYTES> -MB 8 -Hours 9
```

Every iteration appends to `%USERPROFILE%\.p2pgate-soak-mux\client.csv`:

```text
time,ok,bytes,ms,mbps,error,clientRssMB,carriers
```

## 3. Morning

```powershell
# client side
node scripts\soak\summarize.js "$env:USERPROFILE\.p2pgate-soak-mux\client.csv"

# server side
ssh -p 8022 -i $env:USERPROFILE\.ssh\id_ed25519 watthumpra@<host> `
  'cat ~/.p2pgate-soak/server-rss.csv' > server-rss.csv
node scripts\soak\summarize.js server-rss.csv

# server still healthy?
ssh -p 8022 -i $env:USERPROFILE\.ssh\id_ed25519 watthumpra@<host> `
  'HOME=$HOME/.p2pgate-soak/state p2pgate status --json'
```

Pass criteria: `failed = 0`, `carriers = 1` (no reconnect), throughput stable,
client RSS flat, server RSS flat.

## 4. Unattended run (survives the agent/shell)

A long run started from an interactive shell can be killed together with that shell's
process tree. For overnight runs, register the runner with Task Scheduler so it has its
own tree and leaves a trace if it dies:

```powershell
# creds go in %USERPROFILE%\.p2pgate-soak-mux\run.json
schtasks /create /tn p2pgate-soak `
  /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\tunnel\p2pgate\scripts\soak\runner.ps1 -Hours 4 -IntervalMinutes 3" `
  /sc once /st 23:59 /sd 11/17/2026 /f
schtasks /create /tn p2pgate-soak-watch `
  /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\tunnel\p2pgate\scripts\soak\watch.ps1" `
  /sc minute /mo 10 /f

schtasks /run /tn p2pgate-soak
```

- `runner.log` gets `START` / `END exit=` / `CRASH …` lines with timestamps
- `watchdog.log` gets `DEAD … restarting`, or `STALE … stuck?` when the task is alive
  but not producing rows
- the watchdog restarts the task if the CSV stops for more than 20 minutes

Remove the tasks when done:

```powershell
schtasks /delete /tn p2pgate-soak /f
schtasks /delete /tn p2pgate-soak-watch /f
```

## 5. Cleanup

```sh
pkill -f 'target-http.js'
pkill -f '.p2pgate-soak/server.json'
pkill -f 'soak-rss'
rm -rf ~/.p2pgate-soak
termux-unlock
```

`fetch-verify.js` and `summarize.js` are used by the scripts; `target-http.js` is the
HTTP target.
