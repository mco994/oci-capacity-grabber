# oci-capacity-grabber

Tiny GitHub Actions cron that keeps trying to create an **Always Free** Oracle Cloud
ARM instance (`VM.Standard.A1.Flex`, 4 OCPU / 24 GB) in `eu-marseille-1`, working
around the recurring **"Out of host capacity"** error.

## How it works
- `launch.js` signs OCI REST calls with the API key (no SDK).
- Every 15 min it checks whether the `claude-dev` instance already exists; if not, it
  attempts `LaunchInstance`.
- Out of capacity → exits 0 quietly (retries next run).
- **Instance created → exits 1 on purpose**, so GitHub emails you a "run failed"
  notification. That "failure" actually means **success** — go grab the VM's public IP
  in the OCI console, then **disable this workflow** (Actions tab → grab-arm-capacity →
  `···` → Disable workflow).

## Config
- Non-secret values (OCIDs, region, SSH public key) live in `launch.js`.
- The **only secret** is the OCI API private key, stored as the GitHub Actions secret
  `OCI_API_PRIVATE_KEY` (never committed).

## ⚠️ Remember
Delete or disable the workflow once the VM is obtained (GitHub ToU discourages endless
scheduled runs). Free A1 quota is 4 OCPU / 24 GB total — do not run a second instance.
