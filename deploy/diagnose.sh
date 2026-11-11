#!/usr/bin/env bash
# Read-only: prints why a release did not become ready (#73). Run it when `helm upgrade --wait` fails, BEFORE anything is
# rolled back, because rollback removes the pods and their evidence.
#
#   KUBECONFIG=... NAMESPACE=openprism deploy/diagnose.sh
#
# Every pod is covered, Job pods included (a failed attempt keeps its pod and logs).
# `describe` lists container states and events and only the NAMES of the Secrets a pod reads, never their values.
set -uo pipefail
ns="${NAMESPACE:-openprism}"
k() { kubectl -n "$ns" --request-timeout=30s "$@"; }
group() { echo "::group::$1"; }
endgroup() { echo "::endgroup::"; }

group "pods"; k get pods -o wide 2>&1; endgroup
group "jobs"; k get jobs 2>&1; endgroup
# The migrate Job is usually the first thing that fails (the other pods wait for it): its status, conditions and events,
# then every pod it created (one per attempt, restartPolicy Never) with its logs are printed below (#152).
group "jobs: describe"; k describe jobs 2>&1 | sed -n '/^Name:/p;/^Pods Statuses:/p;/^Conditions:/,/^Events:/p;/^Events:/,$p' | head -80; endgroup
group "deployments"; k get deployments 2>&1; endgroup
group "namespace events (newest last)"; k get events --sort-by=.lastTimestamp 2>&1 | tail -40; endgroup
# Pending pods that say "Insufficient cpu/memory" are explained by what the nodes have left. May be refused for this user.
group "nodes: allocatable and already requested"
kubectl --request-timeout=30s describe nodes 2>&1 | sed -n '/^Name:/p;/^Allocatable:/,/^System Info:/p;/^Allocated resources:/,/^Events:/p' | head -80
endgroup

for pod in $(k get pods -o name 2>/dev/null); do
  group "$pod"
  k describe "$pod" 2>&1 | sed -n '/^Init Containers:/,/^Conditions:/p;/^Events:/,$p'
  for c in $(k get "$pod" -o jsonpath='{.spec.initContainers[*].name} {.spec.containers[*].name}' 2>/dev/null); do
    echo "--- logs: $c"
    k logs "$pod" -c "$c" --tail=40 --request-timeout=20s 2>&1 | head -60
    prev="$(k logs "$pod" -c "$c" --previous --tail=20 --request-timeout=20s 2>/dev/null)"
    [ -n "$prev" ] && { echo "--- previous run of $c"; echo "$prev"; }
  done
  endgroup
done
exit 0
