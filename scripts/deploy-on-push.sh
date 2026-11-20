#!/bin/bash
# Deploy-on-push for SyncWave.
#
# Push to `tandy` on the fork and this takes it from there: dev follows the
# branch immediately (it is the test instance), live builds right away and then
# recreates the container at the first moment no audio is playing — because a
# recreate drops the track that is running, and a deploy must not cut a song
# mid-way.
#
# Run by syncwave-deploy.timer on the CT (every 2 minutes). Also safe to run by
# hand; it is idempotent and lock-guarded.
#
# State lives in $STATE:
#   deploy.log   one line per step, append-only
#   pending      a commit that is built but not yet recreated into
#   failed-sha   a commit whose build failed — not retried until a newer one
#
# Exit status is informational; systemd only logs it.
set -u

REPO=${REPO:-/opt/syncwave}
DEV=${DEV:-/opt/syncwave-dev}
STATE=${STATE:-/opt/syncwave-deploy}
HEALTH=${HEALTH:-http://127.0.0.1:3000/api/health}
WAIT_SECONDS=${WAIT_SECONDS:-1200}

mkdir -p "$STATE" || exit 1
LOG=$STATE/deploy.log
say() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

# One at a time. A tick that finds the lock held simply leaves it to the run
# that is waiting for a quiet moment.
exec 9>"$STATE/deploy.lock"
flock -n 9 || exit 0

cd "$REPO" || { say "repo missing: $REPO"; exit 1; }

# ---- dev first: it is the test instance, nobody's song to interrupt ----------
if [ -d "$DEV/src/.git" ]; then
  (
    cd "$DEV/src" || exit 0
    before=$(git rev-parse HEAD 2>/dev/null)
    git fetch -q origin || exit 0
    git merge --ff-only origin/tandy >/dev/null 2>&1 || exit 0
    after=$(git rev-parse HEAD 2>/dev/null)
    # Nothing new: do NOT rebuild. A merge that is already up to date still
    # succeeds, and rebuilding every tick would restart dev three times an hour.
    [ "$before" = "$after" ] && exit 0
    echo "$(date -u +%FT%TZ) dev: ${before:0:7} -> ${after:0:7}"
    cd "$DEV" && docker compose up -d --build
  ) >>"$LOG" 2>&1 || say "dev rebuild failed (live unaffected)"
fi

# ---- live: anything new? ----------------------------------------------------
git fetch -q fork || { say "fetch failed"; exit 1; }
LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse fork/tandy 2>/dev/null)
[ -n "$LOCAL" ] && [ -n "$REMOTE" ] || { say "cannot resolve refs"; exit 1; }

PENDING=$(cat "$STATE/pending" 2>/dev/null || true)
FAILED=$(cat "$STATE/failed-sha" 2>/dev/null || true)

if [ "$REMOTE" = "$FAILED" ]; then
  exit 0 # this commit does not build; wait for a newer one
fi

if [ "$PENDING" != "$REMOTE" ]; then
  if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi # up to date, nothing built

  say "new commits ${LOCAL:0:7} -> ${REMOTE:0:7}"
  if ! git merge --ff-only fork/tandy >>"$LOG" 2>&1; then
    say "MERGE FAILED — local changes in $REPO are blocking; not touching the running container"
    exit 1
  fi

  # The repo copy is the source of truth for humans; this file is what actually
  # runs. Replace it ATOMICALLY (mv, never cp): bash reads a script as it goes,
  # so overwriting this very file mid-run is undefined behaviour. The running
  # process keeps its own inode, and the next tick runs the new logic.
  if [ -f "$REPO/scripts/deploy-on-push.sh" ] && ! cmp -s "$REPO/scripts/deploy-on-push.sh" "$0"; then
    install -m 755 "$REPO/scripts/deploy-on-push.sh" "$STATE/deploy.sh.new" &&
      mv -f "$STATE/deploy.sh.new" "$STATE/deploy.sh" &&
      say "runner updated from the repo"
  fi

  say "building"
  if ! docker compose build >>"$LOG" 2>&1; then
    echo "$REMOTE" >"$STATE/failed-sha"
    say "BUILD FAILED for ${REMOTE:0:7} — staying on the running image, will retry at a newer commit"
    exit 1
  fi
  rm -f "$STATE/failed-sha"
  echo "$REMOTE" >"$STATE/pending"
  say "built ${REMOTE:0:7}"
fi

# ---- wait for a quiet moment ------------------------------------------------
# Two independent signals, because either one alone has a hole:
#
#  * health says nothing is audible, or nobody is listening. A room with zero
#    listeners can sit "playing" for a whole track — it only advances when a
#    client reports the end — so waiting on `playing` alone can hold forever.
#  * the `[dj] boundary` log line, which fires at every track change. Sampling
#    `playing` every couple of seconds MISSES a boundary when the next track is
#    already cached: the room is only not-playing for a few hundred ms.
DEADLINE=$(( $(date +%s) + WAIT_SECONDS ))
waited=0
lastHealth=0
while :; do
  if docker logs --since 5s syncwave 2>&1 | grep -q '\[dj\] boundary'; then
    say "boundary — deploying (${waited}s in)"
    break
  fi

  now=$(date +%s)
  if [ $((now - lastHealth)) -ge 2 ]; then
    lastHealth=$now
    BODY=$(curl -fsS -m 5 "$HEALTH" 2>/dev/null) || BODY=""
    if [ -z "$BODY" ]; then
      # Health unreachable means the app is already down: deploying cannot make
      # a song skip, and it is the fastest way back.
      say "health unreachable — deploying"
      break
    fi
    PLAYING=$(printf '%s' "$BODY" | sed -n 's/.*"playing":\([0-9][0-9]*\).*/\1/p')
    LISTENERS=$(printf '%s' "$BODY" | sed -n 's/.*"listeners":\([0-9][0-9]*\).*/\1/p')
    if [ "${PLAYING:-0}" = "0" ] || [ "${LISTENERS:-0}" = "0" ]; then
      say "quiet (playing=${PLAYING:-?}, listeners=${LISTENERS:-?}) — deploying"
      break
    fi
  fi

  if [ "$now" -ge "$DEADLINE" ]; then
    say "still playing after ${WAIT_SECONDS}s — built, not deployed; next tick keeps waiting"
    exit 0
  fi
  sleep 1
  waited=$((waited + 1))
done

# ---- recreate ---------------------------------------------------------------
docker compose up -d >>"$LOG" 2>&1
sleep 8
NEW=$(curl -fsS -m 5 "$HEALTH" 2>/dev/null || echo '{"health":"unreachable"}')
say "deployed ${REMOTE:0:7}: $NEW"
rm -f "$STATE/pending"
exit 0
