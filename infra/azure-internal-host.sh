#!/usr/bin/env bash
# RFP Sweep and Drafter: create the internal host in Azure (docs/internal-hosting.md).
#
# For your operations team, in Azure Cloud Shell (Bash), signed in with an account that may
# create resources in the subscription and app registrations in Microsoft Entra.
# It prints every step first; nothing changes until you add --apply.
#
#   ACR=<registry> APP=<web-app> ADMINS=first.admin@yourcompany.com bash infra/azure-internal-host.sh
#   ACR=<registry> APP=<web-app> ADMINS=first.admin@yourcompany.com bash infra/azure-internal-host.sh --apply
#
# Run it from the unzipped package (or a clone): the image is built from those files.
#
# Settings (environment variables), with defaults:
#   ACR           container registry name, letters and digits, globally unique   (required)
#   APP           web app name, globally unique                                  (required)
#   ADMINS        first admins' work emails, comma-separated; they add everyone else
#                 on the Configuration page                                      (required)
#   RG            resource group                       rg-rfp-sweep
#   LOCATION      Azure region                         canadacentral
#   PLAN          App Service plan                     asp-rfp-sweep
#   SKU           plan size (Chromium needs memory)    B2
#   TIMEZONE      time zone of the sweep schedule      America/Toronto
#   SOURCE        what to build the image from         this folder (the package or clone the
#                                                      script is in); or a Git URL
#   BRANCH        branch, when SOURCE is a Git URL     main
#   ACCESS_GROUP  object ID of a Microsoft Entra security group; when set, only its members
#                 can sign in at all (the access list then decides who gets in)   (optional)
#
# What it creates: a resource group, a container registry (the image is built there from
# the repository; no Docker needed), a Linux App Service plan with one instance, a web app
# running the image with a managed identity to pull it, persistent /home storage, the app
# settings, and Microsoft Entra sign-in (App Service authentication, your tenant only,
# sign-in required). The sign-in secret goes straight into an app setting; it is never printed.
set -euo pipefail

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

RG="${RG:-rg-rfp-sweep}"
LOCATION="${LOCATION:-canadacentral}"
PLAN="${PLAN:-asp-rfp-sweep}"
SKU="${SKU:-B2}"
TIMEZONE="${TIMEZONE:-America/Toronto}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${SOURCE:-$HERE}"
BRANCH="${BRANCH:-main}"
ACR="${ACR:-}"
APP="${APP:-}"
ADMINS="${ADMINS:-}"
ACCESS_GROUP="${ACCESS_GROUP:-}"
IMAGE="rfp-sweep-drafter"

fail() { echo "error: $*" >&2; exit 1; }
[ -n "$ACR" ] || fail "set ACR, the container registry name (letters and digits)"
[ -n "$APP" ] || fail "set APP, the web app name"
[ -n "$ADMINS" ] || fail "set ADMINS, the first admins' work emails (comma-separated)"
[[ "$ACR" =~ ^[a-zA-Z0-9]{5,50}$ ]] || fail "ACR must be 5-50 letters and digits"
[[ "$APP" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$ ]] || fail "APP must be letters, digits and dashes (2-60)"
[[ "$ADMINS" =~ ^[^[:space:]@,]+@[^[:space:]@,]+(,[[:space:]]*[^[:space:]@,]+@[^[:space:]@,]+)*$ ]] || fail "ADMINS must be work emails separated by commas"
[ -z "$ACCESS_GROUP" ] || [[ "$ACCESS_GROUP" =~ ^[0-9a-fA-F-]{36}$ ]] || fail "ACCESS_GROUP must be the group's object ID"

step() { printf '\n== %s\n' "$*"; }
# Print a command, and run it with --apply.
run() {
  printf '  $'; printf ' %q' "$@"; printf '\n'
  if [ "$APPLY" = 1 ]; then "$@"; fi
}
# Print a command, and with --apply run it and keep its output in the named variable.
capture() {
  local var="$1"; shift
  printf '  %s=$(' "$var"; printf '%q ' "$@"; printf ')\n'
  if [ "$APPLY" = 1 ]; then printf -v "$var" '%s' "$("$@")"; else printf -v "$var" '<%s>' "$var"; fi
}

if [ "$APPLY" = 1 ]; then
  command -v az > /dev/null || fail "the Azure CLI is needed: run this in Azure Cloud Shell"
  az account show > /dev/null || fail "sign in first: az login"
else
  echo "Dry run: these are the steps. Nothing changes until you add --apply."
fi

step "Your subscription and Microsoft Entra tenant"
capture TENANT_ID az account show --query tenantId -o tsv
if [ -d "$SOURCE" ]; then
  # The unzipped package carries its commit in a COMMIT file; a clone knows its own.
  [ -f "$SOURCE/Dockerfile" ] || fail "no Dockerfile in $SOURCE: run the script from the unzipped package, or set SOURCE"
  COMMIT="$(cat "$SOURCE/COMMIT" 2>/dev/null || git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
  CONTEXT="$SOURCE"
  echo "  building from the folder $SOURCE (commit ${COMMIT:-unknown})"
else
  capture COMMIT git ls-remote "$SOURCE" "refs/heads/$BRANCH"
  COMMIT="${COMMIT%%[[:space:]]*}"
  CONTEXT="$SOURCE#$BRANCH"
fi

step "Resource group and container registry; build the image (in Azure, no Docker needed)"
run az group create --name "$RG" --location "$LOCATION" --output none
run az acr create --name "$ACR" --resource-group "$RG" --sku Basic --admin-enabled false --output none
run az acr build --registry "$ACR" --image "$IMAGE:latest" --build-arg "RFP_COMMIT=$COMMIT" "$CONTEXT"

step "App Service plan (Linux, one instance) and the web app"
run az appservice plan create --name "$PLAN" --resource-group "$RG" --is-linux --sku "$SKU" --number-of-workers 1 --output none
run az webapp create --name "$APP" --resource-group "$RG" --plan "$PLAN" --container-image-name "$ACR.azurecr.io/$IMAGE:latest" --output none
capture PRINCIPAL_ID az webapp identity assign --name "$APP" --resource-group "$RG" --query principalId -o tsv
capture ACR_ID az acr show --name "$ACR" --query id -o tsv
if [ "$APPLY" = 1 ]; then echo "  (waiting 30 s for the new identity to reach Microsoft Entra)"; sleep 30; fi
run az role assignment create --assignee-object-id "$PRINCIPAL_ID" --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID" --output none
run az webapp config set --name "$APP" --resource-group "$RG" --generic-configurations '{"acrUseManagedIdentityCreds": true}' --output none
run az webapp config container set --name "$APP" --resource-group "$RG" --container-image-name "$ACR.azurecr.io/$IMAGE:latest" --container-registry-url "https://$ACR.azurecr.io" --output none

step "HTTPS only, TLS 1.2, no FTP, Always On (the schedule needs it), health check"
run az webapp update --name "$APP" --resource-group "$RG" --https-only true --output none
run az webapp config set --name "$APP" --resource-group "$RG" --always-on true --min-tls-version 1.2 --ftps-state Disabled --http20-enabled true --output none
run az webapp config set --name "$APP" --resource-group "$RG" --generic-configurations '{"healthCheckPath": "/healthz"}' --output none

step "App settings (no secrets here)"
run az webapp config appsettings set --name "$APP" --resource-group "$RG" --output none --settings \
  RFP_MODE=internal "RFP_ADMINS=$ADMINS" "RFP_TENANT_ID=$TENANT_ID" RFP_DATA_DIR=/home/data/rfp-sweep \
  "RFP_TIMEZONE=$TIMEZONE" WEBSITES_ENABLE_APP_SERVICE_STORAGE=true WEBSITES_PORT=8080

step "Microsoft Entra sign-in: an app registration for this web app, your tenant only"
capture HOST az webapp show --name "$APP" --resource-group "$RG" --query defaultHostName -o tsv
capture CLIENT_ID az ad app create --display-name "RFP Sweep and Drafter ($APP)" --sign-in-audience AzureADMyOrg --web-redirect-uris "https://$HOST/.auth/login/aad/callback" --enable-id-token-issuance true --query appId -o tsv
capture SP_ID az ad sp create --id "$CLIENT_ID" --query id -o tsv
if [ -n "$ACCESS_GROUP" ]; then
  run az ad sp update --id "$CLIENT_ID" --set appRoleAssignmentRequired=true
  run az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
    --body "{\"principalId\":\"$ACCESS_GROUP\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"00000000-0000-0000-0000-000000000000\"}" --output none
fi
echo "  (a client secret is created and stored in the MICROSOFT_PROVIDER_AUTHENTICATION_SECRET app setting, without printing it)"
if [ "$APPLY" = 1 ]; then
  SECRET="$(az ad app credential reset --id "$CLIENT_ID" --display-name "App Service sign-in" --years 1 --append --query password -o tsv)"
  az webapp config appsettings set --name "$APP" --resource-group "$RG" --settings "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET=$SECRET" --output none
  unset SECRET
fi

step "Turn on App Service authentication: sign-in required, Microsoft only"
run az extension add --name authV2 --upgrade --only-show-errors
run az webapp auth microsoft update --name "$APP" --resource-group "$RG" --client-id "$CLIENT_ID" \
  --client-secret-setting-name MICROSOFT_PROVIDER_AUTHENTICATION_SECRET \
  --issuer "https://login.microsoftonline.com/$TENANT_ID/v2.0" --yes --output none
run az webapp auth update --name "$APP" --resource-group "$RG" --enabled true --action RedirectToLoginPage \
  --redirect-provider AzureActiveDirectory --require-https true --output none
run az webapp restart --name "$APP" --resource-group "$RG"

step "Done"
echo "  Open https://$HOST and sign in as one of: $ADMINS"
echo "  Configuration → This host: every check should be green. Then add the team under Users and access."
echo "  The sign-in secret expires in one year: set a reminder to renew it (docs/internal-hosting.md)."
[ "$APPLY" = 1 ] || echo "  (dry run: nothing was changed)"
