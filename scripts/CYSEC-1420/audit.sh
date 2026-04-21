#!/usr/bin/env bash
# CYSEC-1420 — Pre-migration audit script
# Collects current state of ms365admin-app before network hardening.
# Run this with an account that has at minimum: Reader on the resource group,
# Graph API admin (to read SP permissions), and Log Analytics Reader.
#
# Usage:
#   bash audit.sh [--rg <resource-group>] [--app <container-app-name>] [--out <output-dir>]
# Defaults are pre-set for the production deployment.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via flags or environment variables)
# ---------------------------------------------------------------------------
RG="${CYSEC_RG:-rg-ms365admin-prod}"
APP_NAME="${CYSEC_APP:-ms365admin-app}"
SUBSCRIPTION="${CYSEC_SUBSCRIPTION:-}"          # leave empty to use current az context
SP_DISPLAY_NAME="${CYSEC_SP:-ms365-admin-mcp}"  # display name of the Graph service principal
OUT_DIR="${CYSEC_OUT:-./audit-output}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rg)           RG="$2";            shift 2 ;;
    --app)          APP_NAME="$2";      shift 2 ;;
    --subscription) SUBSCRIPTION="$2"; shift 2 ;;
    --sp)           SP_DISPLAY_NAME="$2"; shift 2 ;;
    --out)          OUT_DIR="$2";       shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/audit.log"
exec > >(tee -a "$LOG") 2>&1

AZ="az"
if [[ -n "$SUBSCRIPTION" ]]; then
  AZ="az --subscription $SUBSCRIPTION"
fi

TS=$(date -u +"%Y%m%dT%H%M%SZ")
echo "=== CYSEC-1420 Audit — $TS ==="
echo "  RG:        $RG"
echo "  App:       $APP_NAME"
echo ""

# ---------------------------------------------------------------------------
# Section 1 — Container App current configuration
# ---------------------------------------------------------------------------
echo "--- [1/5] Container App Configuration ---"

$AZ containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --output json \
  > "$OUT_DIR/01-containerapp-full.json"

# Extract non-sensitive subset (no secrets, no env values flagged as secret)
python3 - <<'PYEOF' "$OUT_DIR/01-containerapp-full.json" "$OUT_DIR/01-containerapp-summary.json"
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

props = data.get("properties", {})
template = props.get("template", {})
containers = template.get("containers", [])

summary = {
    "name": data.get("name"),
    "location": data.get("location"),
    "resourceGroup": data.get("resourceGroup"),
    "ingress": props.get("configuration", {}).get("ingress", {}),
    "identity": data.get("identity", {}),
    "environmentId": props.get("managedEnvironmentId", ""),
    "provisioningState": props.get("provisioningState", ""),
    "scale": template.get("scale", {}),
    "containers": [
        {
            "name": c.get("name"),
            "image": c.get("image"),
            "resources": c.get("resources", {}),
            "env_non_secret": [
                e for e in c.get("env", [])
                if not e.get("secretRef")
            ],
        }
        for c in containers
    ],
}

with open(sys.argv[2], "w") as f:
    json.dump(summary, f, indent=2)

print(f"  Ingress external: {summary['ingress'].get('external', 'N/A')}")
print(f"  Ingress transport: {summary['ingress'].get('transport', 'N/A')}")
print(f"  Identity type: {summary['identity'].get('type', 'None')}")
print(f"  Scale min/max: {summary['scale'].get('minReplicas','?')}/{summary['scale'].get('maxReplicas','?')}")
PYEOF

echo ""
echo "--- Container App Environment ---"
CAE_ID=$($AZ containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --query "properties.managedEnvironmentId" -o tsv)

echo "  CAE resource ID: $CAE_ID"

CAE_NAME=$(echo "$CAE_ID" | awk -F'/' '{print $NF}')
CAE_RG=$(echo "$CAE_ID" | awk -F'/' '{print $(NF-4)}')

$AZ containerapp env show \
  --name "$CAE_NAME" \
  --resource-group "$CAE_RG" \
  --output json \
  > "$OUT_DIR/01-cae-full.json"

python3 - <<'PYEOF' "$OUT_DIR/01-cae-full.json"
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
props = d.get("properties", {})
print(f"  CAE name:           {d.get('name')}")
print(f"  CAE location:       {d.get('location')}")
print(f"  vnet config:        {props.get('vnetConfiguration', 'None (public)')}")
print(f"  zone redundant:     {props.get('zoneRedundant', False)}")
print(f"  workload profiles:  {[p.get('name') for p in props.get('workloadProfiles', [])]}")
PYEOF

echo ""

# ---------------------------------------------------------------------------
# Section 2 — Graph Service Principal permissions
# ---------------------------------------------------------------------------
echo "--- [2/5] Graph Service Principal Permissions ---"

SP_APP_ID=$($AZ ad sp list \
  --display-name "$SP_DISPLAY_NAME" \
  --query "[0].appId" -o tsv 2>/dev/null || echo "")

if [[ -z "$SP_APP_ID" ]]; then
  echo "  WARNING: No SP found with display name '$SP_DISPLAY_NAME'."
  echo "  Set CYSEC_SP env var or --sp flag to the correct display name."
  echo "  Skipping section 2."
else
  echo "  SP App ID: $SP_APP_ID"

  $AZ ad sp show --id "$SP_APP_ID" --output json \
    > "$OUT_DIR/02-sp-full.json"

  # App role assignments (Graph permissions granted)
  $AZ ad sp list \
    --display-name "$SP_DISPLAY_NAME" \
    --query "[0].appRoles" \
    -o json > "$OUT_DIR/02-sp-app-roles.json" 2>/dev/null || echo "[]" > "$OUT_DIR/02-sp-app-roles.json"

  # OAuth2 permissions (delegated)
  $AZ ad app show --id "$SP_APP_ID" --output json \
    > "$OUT_DIR/02-app-registration.json" 2>/dev/null || true

  echo "  Saved SP details to $OUT_DIR/02-sp-full.json"
  echo "  Saved app registration to $OUT_DIR/02-app-registration.json"

  # List role assignments on the service principal
  echo ""
  echo "  Azure RBAC role assignments for SP:"
  $AZ role assignment list \
    --assignee "$SP_APP_ID" \
    --all \
    --output table 2>/dev/null || echo "  (none or insufficient permissions)"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 3 — FQDN references in known systems
# ---------------------------------------------------------------------------
echo "--- [3/5] FQDN References ---"

FQDN=$($AZ containerapp show \
  --name "$APP_NAME" \
  --resource-group "$RG" \
  --query "properties.configuration.ingress.fqdn" -o tsv 2>/dev/null || echo "unknown")

echo "  Current public FQDN: $FQDN"
echo ""
echo "  Search locations to check manually:"
echo "  - Claude Desktop config: ~/Library/Application Support/Claude/claude_desktop_config.json"
echo "  - Vecna agents config:   ~/Projects/project-vecna/  (grep for '$FQDN')"
echo "  - Confluence docs:       Search CSC space for '$FQDN'"
echo "  - Jira issues:           Search CYSEC project for '$FQDN'"
echo "  - GitHub Actions:        Search repo secrets / workflow files"
echo ""

# Local grep for FQDN references
if [[ -d ~/Projects ]]; then
  echo "  Grepping ~/Projects for FQDN references..."
  grep -rl "$FQDN" ~/Projects/ 2>/dev/null | head -20 \
    > "$OUT_DIR/03-fqdn-references.txt" || true
  REFS=$(wc -l < "$OUT_DIR/03-fqdn-references.txt")
  echo "  Found $REFS file(s) — see 03-fqdn-references.txt"
fi

DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
if [[ -f "$DESKTOP_CONFIG" ]]; then
  echo ""
  echo "  Claude Desktop config MCP servers:"
  python3 -c "
import json
with open('$DESKTOP_CONFIG') as f:
    cfg = json.load(f)
servers = cfg.get('mcpServers', {})
for name, s in servers.items():
    url = s.get('url', s.get('command',''))
    print(f'    {name}: {url}')
" 2>/dev/null || echo "  (could not parse)"
fi

echo ""

# ---------------------------------------------------------------------------
# Section 4 — NSG rules on candidate VNets (Canada Central / Canada East)
# ---------------------------------------------------------------------------
echo "--- [4/5] NSG Rules on Candidate VNets ---"

for NSG in "Prod_Backend_nsg" "NSG_CanadaCentral"; do
  echo ""
  echo "  NSG: $NSG"
  NSG_ID=$($AZ network nsg list \
    --query "[?name=='$NSG'].id" -o tsv 2>/dev/null | head -1)

  if [[ -z "$NSG_ID" ]]; then
    echo "    Not found in current subscription — may be in another subscription."
    continue
  fi

  $AZ network nsg show --ids "$NSG_ID" --output json \
    > "$OUT_DIR/04-nsg-${NSG}.json"

  python3 - <<PYEOF "$OUT_DIR/04-nsg-${NSG}.json"
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
rules = d.get("securityRules", [])
print(f"    Location: {d.get('location')}  Custom rules: {len(rules)}")
for r in sorted(rules, key=lambda x: x.get("properties",{}).get("priority",9999)):
    p = r.get("properties", {})
    print(f"    [{p.get('priority','')}] {p.get('direction','')}/{p.get('access','')} "
          f"{p.get('protocol','')} {p.get('sourceAddressPrefix','')}→{p.get('destinationAddressPrefix','')} "
          f":{p.get('destinationPortRange','')} — {r.get('name','')}")
PYEOF
done

echo ""

# ---------------------------------------------------------------------------
# Section 5 — Access logs (last 30 days)
# ---------------------------------------------------------------------------
echo "--- [5/5] Access Logs — Last 30 Days ---"

# Find Log Analytics workspace linked to the CAE
LAW_ID=$($AZ monitor log-analytics workspace list \
  --resource-group "$RG" \
  --query "[0].customerId" -o tsv 2>/dev/null || echo "")

if [[ -z "$LAW_ID" ]]; then
  echo "  No Log Analytics workspace found in RG $RG."
  echo "  Trying to retrieve workspace ID from Container App diagnostics..."
  LAW_ID=$($AZ monitor diagnostic-settings list \
    --resource "$($AZ containerapp show --name "$APP_NAME" --resource-group "$RG" --query id -o tsv)" \
    --query "[0].workspaceId" -o tsv 2>/dev/null | awk -F'/' '{print $NF}' || echo "")
fi

if [[ -z "$LAW_ID" ]]; then
  echo "  WARNING: Could not determine Log Analytics workspace. Skipping log queries."
  echo "  Run the KQL queries in 04-log-queries.kql manually in Azure Portal."
else
  echo "  Log Analytics workspace: $LAW_ID"

  cat > "$OUT_DIR/05-log-queries.kql" <<'KQLEOF'
// CYSEC-1420 — Access log analysis (run in Log Analytics)

// 1. Request volume by source IP (last 30 days)
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where ContainerAppName_s == "ms365admin-app"
| parse Log_s with * "remoteAddr=" RemoteAddr " " *
| summarize RequestCount=count() by RemoteAddr
| order by RequestCount desc
| take 50

// 2. Unique user agents
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where ContainerAppName_s == "ms365admin-app"
| parse Log_s with * "userAgent=\"" UserAgent "\"" *
| summarize Count=count() by UserAgent
| order by Count desc

// 3. Request volume by hour (traffic pattern)
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where ContainerAppName_s == "ms365admin-app"
| summarize Requests=count() by bin(TimeGenerated, 1h)
| render timechart

// 4. Error rate
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where ContainerAppName_s == "ms365admin-app"
| parse Log_s with * "status=" StatusCode " " *
| summarize Count=count() by StatusCode
| order by Count desc

// 5. Tool invocations from MCP logs
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30d)
| where ContainerAppName_s == "ms365admin-app"
| where Log_s contains "Tool " and Log_s contains "called with params"
| parse Log_s with * "Tool " ToolName " called" *
| summarize Invocations=count() by ToolName
| order by Invocations desc
KQLEOF

  echo "  KQL queries saved to $OUT_DIR/05-log-queries.kql"
  echo "  Run them in Azure Portal > Log Analytics workspace > Logs."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Audit Complete ==="
echo "  Output directory: $OUT_DIR"
echo "  Files generated:"
ls -1 "$OUT_DIR/"
echo ""
echo "  Next steps:"
echo "  1. Fill docs/CYSEC-1420/pre-migration-inventory.md with audit findings"
echo "  2. Run KQL queries in Log Analytics (05-log-queries.kql)"
echo "  3. Confirm CIDRs with Saad Tariq before proceeding to IaC"
