#!/usr/bin/env bash
# Renders a Cloud Run (Knative) service manifest from shell variables and applies it
# with `gcloud run services replace`. Declarative and idempotent: re-running a deploy
# converges the service to exactly this configuration (env, secrets, volumes, scaling).
# Rendered manifests are kept in deploy/gcp/rendered/ (git-ignored) for review; they
# contain secret NAMES only, never values.
#
# Inputs (set before calling render_service):
#   S_NAME S_SA S_IMAGE S_PORT S_MIN S_MAX S_CPU S_MEMORY S_CONCURRENCY S_TIMEOUT
#   S_CPU_ALWAYS (true|false)  S_HEALTH (path)  S_COMMAND / S_ARGS (optional, JSON arrays)
#   S_ENV=( "KEY=value" ... )            plain environment variables
#   S_SECRET_ENV=( "KEY=SECRET_ID" ... )  env vars from Secret Manager (latest version)
#   S_GCS_VOLUME="mountPath=bucket"       optional Cloud Storage volume (owned by S_GCS_UID)
#   S_SECRET_FILE="mountDir|file|SECRET"  optional secret mounted as a file

# JSON-quote a string (valid YAML scalar).
yq_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "${s}"
}

reset_service_vars() {
  S_NAME=""; S_SA=""; S_IMAGE=""; S_PORT=8080; S_MIN=0; S_MAX=1; S_CPU=1; S_MEMORY=512Mi
  S_CONCURRENCY=80; S_TIMEOUT=300; S_CPU_ALWAYS=false; S_HEALTH=/health; S_COMMAND=""; S_ARGS=""
  S_ENV=(); S_SECRET_ENV=(); S_GCS_VOLUME=""; S_GCS_UID=10001; S_SECRET_FILE=""
}

render_service() {
  local out="${DEPLOY_DIR}/rendered/${S_NAME}.yaml" kv k v
  mkdir -p "${DEPLOY_DIR}/rendered"
  {
    echo "apiVersion: serving.knative.dev/v1"
    echo "kind: Service"
    echo "metadata:"
    echo "  name: ${S_NAME}"
    echo "  labels:"
    echo "    app: inklink"
    echo "    cloud.googleapis.com/location: ${REGION}"
    echo "  annotations:"
    echo "    run.googleapis.com/ingress: all"
    echo "spec:"
    echo "  template:"
    echo "    metadata:"
    echo "      labels:"
    echo "        app: inklink"
    echo "      annotations:"
    echo "        autoscaling.knative.dev/minScale: \"${S_MIN}\""
    echo "        autoscaling.knative.dev/maxScale: \"${S_MAX}\""
    echo "        run.googleapis.com/cpu-throttling: \"$([[ "${S_CPU_ALWAYS}" == true ]] && echo false || echo true)\""
    echo "        run.googleapis.com/execution-environment: gen2"
    echo "        run.googleapis.com/startup-cpu-boost: \"true\""
    echo "    spec:"
    echo "      serviceAccountName: $(sa_email "${S_SA}")"
    echo "      containerConcurrency: ${S_CONCURRENCY}"
    echo "      timeoutSeconds: ${S_TIMEOUT}"
    echo "      containers:"
    echo "        - image: ${S_IMAGE}"
    [[ -n "${S_COMMAND}" ]] && echo "          command: ${S_COMMAND}"
    [[ -n "${S_ARGS}" ]] && echo "          args: ${S_ARGS}"
    echo "          ports:"
    echo "            - name: http1"
    echo "              containerPort: ${S_PORT}"
    echo "          resources:"
    echo "            limits:"
    echo "              cpu: \"${S_CPU}\""
    echo "              memory: ${S_MEMORY}"
    if (( ${#S_ENV[@]} + ${#S_SECRET_ENV[@]} > 0 )); then
      echo "          env:"
      for kv in "${S_ENV[@]}"; do
        k="${kv%%=*}"; v="${kv#*=}"
        echo "            - name: ${k}"
        echo "              value: $(yq_str "${v}")"
      done
      for kv in "${S_SECRET_ENV[@]}"; do
        k="${kv%%=*}"; v="${kv#*=}"
        echo "            - name: ${k}"
        echo "              valueFrom:"
        echo "                secretKeyRef:"
        echo "                  name: ${v}"
        echo "                  key: latest"
      done
    fi
    if [[ -n "${S_GCS_VOLUME}" || -n "${S_SECRET_FILE}" ]]; then
      echo "          volumeMounts:"
      [[ -n "${S_GCS_VOLUME}" ]] && { echo "            - name: data"; echo "              mountPath: ${S_GCS_VOLUME%%=*}"; }
      [[ -n "${S_SECRET_FILE}" ]] && { echo "            - name: secret-file"; echo "              mountPath: ${S_SECRET_FILE%%|*}"; echo "              readOnly: true"; }
    fi
    echo "          startupProbe:"
    echo "            httpGet:"
    echo "              path: ${S_HEALTH}"
    echo "              port: ${S_PORT}"
    echo "            periodSeconds: 5"
    echo "            timeoutSeconds: 4"
    echo "            failureThreshold: 24"
    echo "          livenessProbe:"
    echo "            httpGet:"
    echo "              path: ${S_HEALTH}"
    echo "              port: ${S_PORT}"
    echo "            periodSeconds: 30"
    echo "            timeoutSeconds: 5"
    echo "            failureThreshold: 3"
    if [[ -n "${S_GCS_VOLUME}" || -n "${S_SECRET_FILE}" ]]; then
      echo "      volumes:"
      if [[ -n "${S_GCS_VOLUME}" ]]; then
        echo "        - name: data"
        echo "          csi:"
        echo "            driver: gcsfuse.run.googleapis.com"
        echo "            readOnly: false"
        echo "            volumeAttributes:"
        echo "              bucketName: ${S_GCS_VOLUME#*=}"
        # The images run as non-root: give the container user ownership of the mount.
        echo "              mountOptions: \"uid=${S_GCS_UID},gid=${S_GCS_UID}\""
      fi
      if [[ -n "${S_SECRET_FILE}" ]]; then
        local rest="${S_SECRET_FILE#*|}"
        echo "        - name: secret-file"
        echo "          secret:"
        echo "            secretName: ${rest#*|}"
        echo "            items:"
        echo "              - key: latest"
        # Default mode (0444): the containers run as non-root users.
        echo "                path: ${rest%%|*}"
      fi
    fi
    echo "  traffic:"
    echo "    - latestRevision: true"
    echo "      percent: 100"
  } > "${out}"
  echo "${out}"
}

apply_service() {
  local file
  file="$(render_service)"
  echo "  manifest: ${file#"${REPO_ROOT}/"}"
  gc run services replace "${file}" --region="${REGION}" --format='value(status.url)' >/dev/null
  local url
  url="$(gc run services describe "${S_NAME}" --region="${REGION}" --format='value(status.url)')"
  ok "${S_NAME} → ${url}"
}

make_public() { # service
  grant_invoker "$1" allUsers
  ok "$1 is public (allUsers → run.invoker); the app enforces its own auth"
}
