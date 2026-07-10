// TinyApe Sync Layer (v2 — Realtime-first)
// ──────────────────────────────────────────
// Local-first: in-memory store is always fast, DB writes are async.
// Supabase Realtime pushes row-level changes from other devices.
// Echo suppression prevents our own writes from triggering re-renders.
// Failed writes are queued and retried automatically.

(function() {
  'use strict';

  // ─── RETRY QUEUE ───
  // Entries store a task ID (NOT a frozen copy). At flush time we re-resolve the
  // LIVE task from the store so a retry always writes the task's CURRENT state.
  // This prevents a stale snapshot (e.g. captured while a task was still
  // incomplete) from later clobbering a newer state (e.g. after completion) and
  // making the task "pop back" into Today. Deletes carry an explicit terminal
  // `payload` because the killed local object isn't guaranteed to be findable.
  const pendingWrites = [];  // [{ id, retries: 0, payload?: {...} }]
  const MAX_RETRIES = 10;
  let _inFlightSaves = 0;

  // ─── PER-TASK WRITE CHAIN (P0-3) ───
  // At most one in-flight write per task; rapid mutations to the same task
  // coalesce into a single trailing write that always sends the LIVE state.
  // This stops parallel UPDATEs for one row from landing out of order and
  // leaving the DB (and the next refresh) holding older state — the "revert /
  // pop-back / delete flip-flop" class of bug.
  const _writeChains = new Map();   // taskId (string) -> Promise (tail of the chain)
  const _dirty = new Set();         // taskIds with a queued coalesced write

  // ─── SCHEDULED FLUSH (with ESCALATING backoff) ───
  // Drains the queue on its own so a failed save self-heals without user action.
  // CRITICAL: the delay escalates with a consecutive-failure streak, NOT with
  // pendingWrites' retry count. The old version read the retry count from
  // pendingWrites only, so an OUTBOX-only stuck entry reported 0 retries and
  // retried every 5s forever — hammering a saturated DB and causing statement
  // timeouts (Supabase Disk-IO depletion). Now a write that keeps failing backs
  // off to 5 minutes instead of retrying 12x/minute.
  const FLUSH_BACKOFF = [5000, 15000, 60000, 300000];  // 5s → 15s → 1m → 5m
  const FAIL_THRESHOLD = 3;                     // retries before we warn the user
  let _flushTimer = null;
  let _flushFailStreak = 0;                     // consecutive flushes that didn't fully drain

  function _scheduleFlush() {
    if (_flushTimer) return;
    const delay = FLUSH_BACKOFF[Math.min(_flushFailStreak, FLUSH_BACKOFF.length - 1)];
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      if (!window._flushSyncQueue) return;
      window._flushSyncQueue().then(() => {
        if (pendingWrites.length > 0 || _outboxSize() > 0) {
          _flushFailStreak++;      // still stuck → back off further next time
          _scheduleFlush();
        } else {
          _flushFailStreak = 0;    // drained → reset the backoff
        }
      });
    }, delay);
  }

  // Surface persistent write failure to the user (see index.html _setSyncFailure).
  // Counts retry-queue entries past FAIL_THRESHOLD, PLUS outbox entries stuck
  // for over a minute — otherwise the banner would clear when a write exhausts
  // MAX_RETRIES and drops out of pendingWrites while the durable outbox still
  // holds (and keeps retrying) the unsynced data.
  const OUTBOX_STUCK_MS = 60000;
  function _reportSyncHealth() {
    const now = Date.now();
    let failing = pendingWrites.filter(e => (e.retries || 0) >= FAIL_THRESHOLD).length;
    const o = _outboxRead();
    failing += Object.values(o.tasks).concat(Object.values(o.completions))
      .filter(e => e._addedAt && (now - e._addedAt > OUTBOX_STUCK_MS)).length;
    if (window._setSyncFailure) window._setSyncFailure(failing);
  }

  // Queue (or refresh) a retry for a task id, de-duplicated by id.
  function _queueRetry(id, payload) {
    const existing = pendingWrites.find(e => String(e.id) === String(id));
    if (existing) {
      // Keep the most recent terminal payload (delete) if provided
      if (payload) existing.payload = payload;
      return;
    }
    pendingWrites.push({ id, retries: 0, payload: payload || null });
  }

  // Re-resolve the live task object for a queued id (active or killed list).
  function _resolveLiveTask(id) {
    const idStr = String(id);
    return store.tasks.find(t => String(t.id) === idStr || (t._localId != null && String(t._localId) === idStr))
        || store.killedTasks.find(t => String(t.id) === idStr || (t._localId != null && String(t._localId) === idStr))
        || null;
  }

  // ─── ECHO SUPPRESSION ───
  // When we write to DB, the realtime subscription will echo that change back.
  // We track recent writes so the realtime handler can skip our own changes.
  const _recentWrites = new Map();    // id (string) -> timestamp
  const _recentCompletionEvents = new Map();  // completion event id -> timestamp (P2-1)
  let _lastCompletionWrite = 0;       // timestamp of last completion event write/delete (legacy fallback)
  let _lastCategoryWrite = 0;         // timestamp of last category write/delete

  function _markWritten(id) {
    if (id == null) return;
    const now = Date.now();
    _recentWrites.set(String(id), now);
    // Prune entries older than 15 seconds on every call (P2-5) so the map
    // never accumulates stale ids. Cheap — the map holds only recent writes.
    for (const [key, ts] of _recentWrites) {
      if (now - ts > 15000) _recentWrites.delete(key);
    }
  }

  // ─── DURABLE OUTBOX (localStorage) ───
  // In-memory queues die if the tab is discarded (Chrome Memory Saver evicts a
  // backgrounded tab; nothing about tasks was persisted locally). The outbox
  // mirrors every unsynced task upsert + completion event to localStorage, so a
  // discard/reload/offline can't lose a completion — boot replays it. Tagged by
  // user so a shared browser doesn't bleed accounts.
  const OUTBOX_KEY = 'tinyape-outbox';

  function _outboxRead() {
    try {
      const raw = localStorage.getItem(OUTBOX_KEY);
      if (!raw) return { userId: null, tasks: {}, completions: {} };
      const o = JSON.parse(raw);
      return { userId: o.userId || null, tasks: o.tasks || {}, completions: o.completions || {} };
    } catch (e) {
      return { userId: null, tasks: {}, completions: {} };
    }
  }
  function _outboxWrite(o) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(o)); } catch (e) { /* private mode / quota */ }
  }
  // Snapshot the task fields the DB layer maps (avoid stashing transient _flags).
  function _outboxTaskSnapshot(t) {
    return {
      id: t.id, title: t.title, today: t.today, todayOrder: t.todayOrder,
      done: t.done, completedAt: t.completedAt, recurring: t.recurring,
      recurDays: t.recurDays, dueDate: t.dueDate, notes: t.notes, drawer: t.drawer,
      drawerCategory: t.drawerCategory, isProject: t.isProject, trackTime: t.trackTime,
      projectOrder: t.projectOrder, killed: !!t.killed, killedAt: t.killedAt || null
    };
  }
  function _outboxAddTask(task) {
    if (!task || task.id == null) return;
    const o = _outboxRead();
    o.userId = window._currentUserId || o.userId || null;
    const snap = _outboxTaskSnapshot(task);
    // Age-stamp for the stuck-write warning (_reportSyncHealth). Preserve the
    // FIRST unsynced timestamp across re-adds so age reflects how long the
    // entry has actually been failing. Inert extra field: _mapJsTaskToDb
    // whitelists columns, so it never reaches the DB.
    const prev = o.tasks[String(task.id)];
    snap._addedAt = (prev && prev._addedAt) ? prev._addedAt : Date.now();
    o.tasks[String(task.id)] = snap;
    _outboxWrite(o);
  }
  function _outboxRemoveTask(id) {
    const o = _outboxRead();
    if (o.tasks[String(id)]) { delete o.tasks[String(id)]; _outboxWrite(o); }
  }
  function _outboxAddCompletion(entry) {
    if (!entry || entry.id == null) return;
    const o = _outboxRead();
    o.userId = window._currentUserId || o.userId || null;
    const prev = o.completions[String(entry.id)];
    o.completions[String(entry.id)] = {
      id: entry.id, taskId: entry.taskId || null, ts: entry.ts,
      _addedAt: (prev && prev._addedAt) ? prev._addedAt : Date.now()
    };
    _outboxWrite(o);
  }
  function _outboxRemoveCompletion(eventId) {
    const o = _outboxRead();
    if (o.completions[String(eventId)]) { delete o.completions[String(eventId)]; _outboxWrite(o); }
  }
  function _outboxSize() {
    const o = _outboxRead();
    return Object.keys(o.tasks).length + Object.keys(o.completions).length;
  }
  function _outboxClear() {
    try { localStorage.removeItem(OUTBOX_KEY); } catch (e) {}
  }
  window._outboxSize = _outboxSize;
  // Snapshot for boot replay. Only returns entries for the current user (or
  // untagged), so a shared browser can't surface another account's writes.
  window._outboxSnapshot = function() {
    const o = _outboxRead();
    const uid = window._currentUserId || null;
    if (o.userId && uid && o.userId !== uid) return { tasks: {}, completions: {} };
    return { tasks: o.tasks, completions: o.completions };
  };

  // ─── EXPOSED HELPERS ───

  window._syncQueue = pendingWrites;  // for debugging

  // Resolve a task ID that might be stale (integer ID replaced by UUID).
  // Coerce to string so numeric DOM data-ids match after ID swap.
  window._findTaskById = function(id) {
    const idStr = String(id);
    return store.tasks.find(t => String(t.id) === idStr || (t._localId != null && String(t._localId) === idStr));
  };

  window._hasPendingWrites = function() {
    return pendingWrites.length > 0 || _inFlightSaves > 0 || _dirty.size > 0;
  };

  // Wipe all in-memory sync state (P2-3). Called on sign-out so the next user
  // on a shared device doesn't inherit the previous user's queued writes,
  // echo marks, or write chains.
  window._resetSyncState = function() {
    pendingWrites.length = 0;
    _recentWrites.clear();
    _recentCompletionEvents.clear();
    _writeChains.clear();
    _dirty.clear();
    _inFlightSaves = 0;
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _flushFailStreak = 0;
    _lastCompletionWrite = 0;
    _lastCategoryWrite = 0;
    _outboxClear();   // don't let one account's unsynced writes bleed into the next
  };

  // True if a task has an unsent write: a deferred add-task timer OR a queued
  // retry. Used by refreshFromSupabase to keep a not-yet-persisted task from
  // being removed just because it isn't in the DB response yet (replaces the
  // old numeric-id keep-branch now that IDs are client-generated UUIDs).
  window._isPendingSave = function(id) {
    const idStr = String(id);
    if (_dirty.has(idStr)) return true;
    if (pendingWrites.some(e => String(e.id) === idStr)) return true;
    const t = store.tasks.find(x => String(x.id) === idStr);
    return !!(t && t._pendingSaveTimer);
  };

  // Check if it's safe to do a FULL refresh from DB
  // (used by the infrequent fallback poll and tab-focus refresh)
  window._isSafeToSync = function() {
    if (_inFlightSaves > 0) return false;
    if (pendingWrites.length > 0) return false;
    if (_dirty.size > 0) return false;
    // NOTE: the durable outbox is deliberately NOT checked here. A stuck outbox
    // entry must never block a REFRESH/READ (that stranded the initial load —
    // tasks couldn't populate while a write was failing). Unsynced state is
    // protected instead by re-layering the outbox after each merge + the
    // in-flight (_inFlightSaves) guard, not by blocking the read.
    if (store.tasks.some(t => t._pendingSaveTimer)) return false;
    return true;
  };

  // Re-send everything still sitting in the durable outbox (idempotent upserts).
  // Called from the flush points and on boot, so a discard/offline gap self-heals.
  window._flushOutbox = async function() {
    const DB = window.TinyApeDB;
    if (!DB) return;
    let o = _outboxRead();
    for (const id of Object.keys(o.tasks)) {
      // Prefer the LIVE task (its current state) over the stored snapshot, so a
      // flush never replays a stale snapshot over a newer state (e.g. a task
      // completed after its first write failed). The snapshot is only the
      // fallback for when the live task is gone (post-discard/reload).
      const payload = _resolveLiveTask(id) || o.tasks[id];
      try {
        const saved = await DB.saveTask(payload);
        if (saved) _outboxRemoveTask(saved.id != null ? saved.id : id);
      } catch (e) { /* keep for the next flush */ }
    }
    o = _outboxRead();
    for (const eid of Object.keys(o.completions)) {
      const c = o.completions[eid];
      try {
        const saved = await DB.saveCompletionEvent(c.taskId, c.id);
        if (saved) _outboxRemoveCompletion(c.id);
      } catch (e) { /* keep */ }
    }
    _reportSyncHealth();
  };

  // Flush all pending writes to Supabase (called before full refresh)
  window._flushSyncQueue = async function() {
    const DB = window.TinyApeDB;
    if (!DB) return;

    if (pendingWrites.length === 0) {
      // Drain the durable outbox in the BACKGROUND (not awaited) so a slow or
      // stuck outbox write never delays a refresh/read.
      window._flushOutbox();
      return;
    }

    const batch = pendingWrites.splice(0, pendingWrites.length);
    const stillFailing = [];

    for (const entry of batch) {
      // Re-resolve the LIVE task so we never replay a stale snapshot.
      // Deletes carry an explicit terminal payload (killed=true).
      const taskToSave = entry.payload || _resolveLiveTask(entry.id);
      if (!taskToSave) {
        // Task no longer exists locally (e.g. removed) — nothing to retry.
        continue;
      }
      try {
        _markWritten(taskToSave.id);
        const saved = await DB.saveTask(taskToSave);
        // A null return is a SILENT failure (RLS/constraint/400/expired session).
        // Treat it exactly like a thrown error so the entry keeps retrying
        // instead of being dropped and lost on reload.
        if (!saved) throw new Error('saveTask returned null (soft failure)');
        // IDs are client-generated (P0-1) and never change, so no swap needed.
        _markWritten(saved.id);
      } catch (err) {
        console.error('Retry failed for task:', taskToSave.title, err);
        entry.retries++;
        if (entry.retries < MAX_RETRIES) {
          stillFailing.push(entry);
        } else {
          console.error('Giving up on task after max retries:', taskToSave.title);
        }
      }
    }

    stillFailing.forEach(e => pendingWrites.push(e));
    _reportSyncHealth();
    // Drain the durable outbox in the BACKGROUND (not awaited).
    window._flushOutbox();
    if (pendingWrites.length > 0 || _outboxSize() > 0) {
      _scheduleFlush();
    } else {
      _flushFailStreak = 0;   // fully drained via this path — reset the backoff
    }
  };

  // Track an arbitrary async op through in-flight counter
  window._trackAsyncOp = function(promiseFn) {
    _inFlightSaves++;
    return promiseFn().then(result => {
      _inFlightSaves--;
      return result;
    }).catch(err => {
      _inFlightSaves--;
      throw err;
    });
  };

  // Echo suppression: check if a realtime event is our own write
  window._isEcho = function(id) {
    if (id == null) return false;
    const ts = _recentWrites.get(String(id));
    return ts != null && (Date.now() - ts < 15000);
  };

  window._isCompletionEcho = function() {
    return (Date.now() - _lastCompletionWrite < 15000);
  };

  // Per-event echo suppression (P2-1). Keyed on the completion event id so a
  // legitimate remote completion is NOT dropped just because this device wrote
  // a *different* completion recently (the flaw of the global timestamp above).
  window._markCompletionEventWrite = function(eventId) {
    if (eventId == null) return;
    const now = Date.now();
    _recentCompletionEvents.set(String(eventId), now);
    _lastCompletionWrite = now;  // keep legacy guard warm for unlinked events
    for (const [k, ts] of _recentCompletionEvents) {
      if (now - ts > 15000) _recentCompletionEvents.delete(k);
    }
  };
  window._isCompletionEventEcho = function(eventId) {
    if (eventId == null) return false;
    const ts = _recentCompletionEvents.get(String(eventId));
    return ts != null && (Date.now() - ts < 15000);
  };

  // ─── STICKY COMPLETION GUARD ───
  // How long a locally-completed task is protected from being flipped back to
  // not-done by an incoming DB/realtime row. Covers the gap between a fast
  // completion and the write landing + echoing. Auto-expires so a *genuine*
  // remote un-complete from another device still applies on a later refresh.
  const STICKY_COMPLETE_MS = 30000;

  // Returns true if `local` is a recent local completion and `incoming` would
  // un-complete it (and isn't a kill). If so, callers must keep local state.
  window._isStickyComplete = function(local, incoming) {
    if (!local || !local.done || !local._completedLocallyAt) return false;
    if (Date.now() - local._completedLocallyAt > STICKY_COMPLETE_MS) return false;
    if (!incoming || incoming.killed) return false;        // kills always win
    return incoming.done === false;                        // suspect un-complete
  };

  // Allow app.js (handleUncomplete) to mark a completion write
  window._markCompletionWrite = function() {
    _lastCompletionWrite = Date.now();
  };

  window._isCategoryEcho = function() {
    return (Date.now() - _lastCategoryWrite < 15000);
  };

  window._getUnsavedTaskIds = function() {
    const unsaved = new Set();
    store.tasks.forEach(t => {
      if (typeof t.id === 'number') unsaved.add(t.id);
    });
    pendingWrites.forEach(e => unsaved.add(e.id));
    return unsaved;
  };

  // ─── API PATCHING ───
  // Wait for app.js to define `api` and `store`, then monkey-patch mutations
  function patchApiForSync() {
    if (typeof api === 'undefined' || typeof store === 'undefined') {
      setTimeout(patchApiForSync, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) {
      console.warn('TinyApeDB not available — running in offline mode');
      return;
    }

    // Helper: persist a task to Supabase via a per-task write chain (P0-3).
    // Guarantees at most one in-flight write per task, coalesces bursts into a
    // single trailing write, and always sends the task's LIVE state — so rapid
    // mutations to one row can't land out of order and revert each other.
    function persistTask(task) {
      if (!task) return;
      // Cancel any pending delayed save from addTask (prevents double INSERT)
      if (task._pendingSaveTimer) {
        clearTimeout(task._pendingSaveTimer);
        delete task._pendingSaveTimer;
      }
      const key = String(task.id);
      // Mark BEFORE save so echo suppression covers the entire round-trip
      _markWritten(task.id);
      // Coalesce: if a write for this task is already queued, it will pick up
      // the latest state when it fires — don't stack another.
      if (_dirty.has(key)) return;
      _dirty.add(key);
      const prev = _writeChains.get(key) || Promise.resolve();
      const next = prev.then(() => {
        // Clear BEFORE the send so a mutation arriving during this write
        // re-queues a fresh trailing write.
        _dirty.delete(key);
        const inActive = store.tasks.some(t => String(t.id) === key);
        // Gone from the active list since this write was queued — either killed
        // (the deleteTask patch owns that write) or removed outright (e.g. an
        // undone recurring respawn, P2-2). Skip so we never re-create it.
        if (!inActive) return;
        const live = _resolveLiveTask(key) || task;   // always send CURRENT state
        _markWritten(live.id);
        _outboxAddTask(live);   // durable: survives a tab discard until the DB confirms
        _inFlightSaves++;
        return DB.saveTask(live).then(saved => {
          _inFlightSaves--;
          // A null return is a silent failure — queue a retry, don't drop it.
          if (!saved) {
            console.error('Sync error (saveTask returned null), queueing retry:', live.title);
            _queueRetry(live.id);
            _scheduleFlush();
            return;
          }
          // IDs are client-generated (P0-1) and never change — no swap needed.
          _markWritten(saved.id);
          _outboxRemoveTask(saved.id);   // confirmed in DB — drop from the durable outbox
          // Remember the order we just persisted so persistTodayOrder can skip
          // this task next time if its order hasn't changed (write amplification).
          live._lastPersistedOrder = live.todayOrder;
          // Optimistic-concurrency watermark (P0-3): remember the server
          // updated_at we just wrote so a later, OLDER DB read can't revert us.
          if (saved.updatedAt) live._lastSyncedUpdatedAt = saved.updatedAt;
        }).catch(err => {
          _inFlightSaves--;
          console.error('Sync error (saveTask), queueing retry:', err);
          // Queue by ID — flush re-resolves the LIVE task so a later state
          // (e.g. the task getting completed) is what actually gets written.
          _queueRetry(live.id);
          _scheduleFlush();
        });
      });
      // Keep the chain alive after errors so subsequent writes still run.
      _writeChains.set(key, next.catch(() => {}));
    }

    // Helper: persist all today tasks (for reorder)
    function persistTodayOrder() {
      // Only re-save Today tasks whose order ACTUALLY changed since we last
      // persisted them. The old version wrote EVERY Today task on every
      // complete/reorder/move — N writes (and N realtime broadcasts) per action,
      // a big share of the DB write volume. `_lastPersistedOrder` is stamped on
      // each successful task write (see persistTask).
      const todayTasks = store.tasks.filter(t => t.today && !t.done);
      todayTasks.forEach(t => {
        if (t._lastPersistedOrder !== t.todayOrder) persistTask(t);
      });
    }

    // ─── Patch addTask ───
    const _origAddTask = api.addTask.bind(api);
    api.addTask = function(title, category, recurring, recurDays, dueDate, drawer) {
      const task = _origAddTask(title, category, recurring, recurDays, dueDate, drawer);
      _markWritten(task.id);
      task._pendingSaveTimer = setTimeout(() => {
        delete task._pendingSaveTimer;
        persistTask(task);
      }, 300);
      return task;
    };

    // ─── Patch deleteTask ───
    const _origDeleteTask = api.deleteTask.bind(api);
    api.deleteTask = function(id) {
      const task = store.tasks.find(t => t.id === id);
      console.log('[Sync:DELETE] Killing task:', id, task ? task.title : '(not found)');
      if (!task) {
        console.error('[Sync:DELETE] ❌ Task not found in store.tasks! ID:', id);
        _origDeleteTask(id);
        return;
      }
      // Capture the save payload BEFORE _origDeleteTask mutates store,
      // using the exact task ID (not a title-based lookup which could
      // match a previously-killed task with the same name).
      const toSave = { ...task, killed: true, killedAt: new Date().toISOString() };
      _markWritten(id);
      _origDeleteTask(id);
      // Serialize the kill onto the task's write chain (fixes "deleted-from-Today
      // task pops back until the next sync"). The kill MUST run after any
      // pending/in-flight killed=false write for this task (e.g. a recent reorder
      // via persistTodayOrder); otherwise that older write can land last in the
      // DB and resurrect the task on the next refresh. _inFlightSaves is bumped
      // synchronously so a refresh is blocked until the kill actually lands.
      const key = String(id);
      _outboxAddTask(toSave);   // durable kill — survives a tab discard
      const prev = _writeChains.get(key) || Promise.resolve();
      _inFlightSaves++;
      const next = prev.then(() => DB.saveTask(toSave)).then(saved => {
        _inFlightSaves--;
        if (saved) {
          _markWritten(saved.id);
          _outboxRemoveTask(saved.id);
          console.log('[Sync:DELETE] ✅ DB confirmed kill:', saved.id, saved.title);
        } else {
          console.error('[Sync:DELETE] ❌ DB returned null — queueing retry');
          // Silent failure: the kill never persisted. Retry with the terminal
          // payload so the task doesn't resurrect on reload.
          _queueRetry(id, toSave);
          _scheduleFlush();
        }
      }).catch(err => {
        _inFlightSaves--;
        console.error('[Sync:DELETE] ❌ DB error:', err);
        // Deletes carry an explicit terminal payload (killed=true) since the
        // killed local object may not be re-resolvable from the active list.
        _queueRetry(id, toSave);
        _scheduleFlush();
      });
      _writeChains.set(key, next.catch(() => {}));
    };

    // ─── Patch voteUp ───
    const _origVoteUp = api.voteUp.bind(api);
    api.voteUp = function(id) {
      const task = _origVoteUp(id);
      persistTask(task);
      return task;
    };

    // ─── Patch moveToDrawer ───
    const _origMoveToDrawer = api.moveToDrawer.bind(api);
    api.moveToDrawer = function(id) {
      const task = _origMoveToDrawer(id);
      persistTask(task);
      persistTodayOrder();
      return task;
    };

    // ─── Patch moveFromDrawer ───
    const _origMoveFromDrawer = api.moveFromDrawer.bind(api);
    api.moveFromDrawer = function(id) {
      const task = _origMoveFromDrawer(id);
      persistTask(task);
      return task;
    };

    // ─── Patch restoreTask ───
    const _origRestoreTask = api.restoreTask.bind(api);
    api.restoreTask = function(killedIndex) {
      const task = _origRestoreTask(killedIndex);
      if (task) {
        _markWritten(task.id);
        persistTask(task);
      }
      return task;
    };

    // ─── Patch setTaskDrawerCategory ───
    const _origSetCat = api.setTaskDrawerCategory.bind(api);
    api.setTaskDrawerCategory = function(id, catKey) {
      _origSetCat(id, catKey);
      const task = store.tasks.find(t => t.id === id);
      persistTask(task);
    };

    // ─── Patch toggleProject ───
    const _origToggleProject = api.toggleProject.bind(api);
    api.toggleProject = function(id) {
      const task = _origToggleProject(id);
      persistTask(task);
      return task;
    };

    // ─── Patch addTimeSession ───
    const _origAddTime = api.addTimeSession.bind(api);
    api.addTimeSession = function(id, date, minutes, note) {
      const task = _origAddTime(id, date, minutes, note);
      persistTask(task);
      DB.saveTimeSession({ taskId: id, date, minutes, note: note || '' })
        .then(saved => {
          // Store the DB id on the local session so we can delete/update it later
          if (saved && saved.id && task && task.timeSessions) {
            const last = task.timeSessions[task.timeSessions.length - 1];
            if (last && last.date === date && last.minutes === minutes) {
              last.id = saved.id;
            }
          }
        })
        .catch(err => console.error('Sync error (addTimeSession):', err));
      return task;
    };

    // ─── Patch deleteTimeSession ───
    const _origDelTime = api.deleteTimeSession.bind(api);
    api.deleteTimeSession = function(id, idx) {
      // Grab the DB session id BEFORE splicing
      const task = store.tasks.find(t => t.id === id);
      const sessions = task && task.timeSessions ? task.timeSessions.slice().sort((a, b) => b.date.localeCompare(a.date)) : [];
      const session = sessions[idx];
      const dbSessionId = session && session.id;

      _origDelTime(id, idx);
      persistTask(task);

      // Delete from time_sessions table in DB
      if (dbSessionId) {
        DB.deleteTimeSession(dbSessionId)
          .catch(err => console.error('Sync error (deleteTimeSession):', err));
      }
    };

    // ─── Patch updateTimeSession ───
    api.updateTimeSession = function(taskId, sessionIdx, updates) {
      const task = store.tasks.find(t => t.id === taskId);
      if (!task || !task.timeSessions) return;
      // Sessions are displayed sorted desc by date — find the right one
      const sorted = task.timeSessions.slice().sort((a, b) => b.date.localeCompare(a.date));
      const session = sorted[sessionIdx];
      if (!session) return;

      // Update local
      if (updates.date !== undefined) session.date = updates.date;
      if (updates.minutes !== undefined) session.minutes = updates.minutes;
      if (updates.note !== undefined) session.note = updates.note;

      persistTask(task);

      // Update in DB
      if (session.id) {
        DB.updateTimeSession(session.id, updates)
          .catch(err => console.error('Sync error (updateTimeSession):', err));
      }
    };

    // ─── Patch toggleDone ───
    const _origToggleDone = api.toggleDone.bind(api);
    api.toggleDone = function(id) {
      const task = _origToggleDone(id);
      if (task) {
        // Stamp the moment of a local completion so a slow/stale DB read or
        // realtime echo can't flip it back to not-done within the sticky window.
        // (See window._isStickyComplete — guards against "pop back" on fast moves.)
        if (task.done) task._completedLocallyAt = Date.now();
        else task._completedLocallyAt = null;
      }
      persistTask(task);
      if (task && task.done) {
        // completion event saved via logCompletion patch (called by bumpCounter)
        persistTodayOrder();
        // Persist the recurring respawn by its explicit link (P2-2), not by a
        // title match that could grab the wrong task when titles collide.
        const respawned = store.tasks.find(t =>
          t._respawnOf === task.id && !t.done && t.recurring);
        if (respawned) persistTask(respawned);
      } else if (task && task._removedRespawnId) {
        // Uncomplete removed the respawn locally. If it already landed in the
        // DB, hard-delete it (a never-completed fresh task — not a soft "kill",
        // so it shouldn't show in the Killed archive). If it never synced, the
        // write-chain guard above already skipped its create, so this no-ops.
        const rid = task._removedRespawnId;
        delete task._removedRespawnId;
        _markWritten(rid);  // suppress the realtime DELETE echo on this device
        DB.deleteTask(rid).catch(err => console.error('Sync error (delete respawn):', err));
      }
      return task;
    };

    // ─── Patch removeFromToday ───
    const _origRemoveFromToday = api.removeFromToday.bind(api);
    api.removeFromToday = function(id) {
      const task = _origRemoveFromToday(id);
      persistTask(task);
      persistTodayOrder();
      return task;
    };

    // ─── Patch _reorderToday ───
    const _origReorder = api._reorderToday.bind(api);
    api._reorderToday = function() {
      _origReorder();
      persistTodayOrder();
    };

    // ─── Patch reorderToday (drag version) ───
    if (api.reorderToday) {
      const _origReorderPublic = api.reorderToday.bind(api);
      api.reorderToday = function(orderedIds) {
        _origReorderPublic(orderedIds);
        persistTodayOrder();
      };
    }

    // ─── Patch reorderProjects (drag version) ───
    if (api.reorderProjects) {
      const _origReorderProjects = api.reorderProjects.bind(api);
      api.reorderProjects = function(orderedIds) {
        _origReorderProjects(orderedIds);
        orderedIds.forEach(id => {
          const task = window._findTaskById ? window._findTaskById(id) : store.tasks.find(t => t.id === id);
          if (task) persistTask(task);
        });
      };
    }

    // ─── Patch addDrawerCategory ───
    const _origAddCat = api.addDrawerCategory.bind(api);
    api.addDrawerCategory = function(key, label, color) {
      _lastCategoryWrite = Date.now();
      _origAddCat(key, label, color);
      DB.saveDrawerCategory({ key, label, color, sortOrder: Object.keys(store.drawerCategories).length })
        .then(saved => {
          // Re-key in-memory from local key to DB UUID so delete works correctly
          if (saved && saved.id && saved.id !== key && store.drawerCategories[key]) {
            store.drawerCategories[saved.id] = { id: saved.id, label: store.drawerCategories[key].label, color: store.drawerCategories[key].color };
            delete store.drawerCategories[key];
            // Update any tasks referencing the old key
            store.tasks.forEach(t => { if (t.drawerCategory === key) t.drawerCategory = saved.id; });
            _lastCategoryWrite = Date.now();
            render();
          }
        })
        .catch(err => console.error('Sync error (addDrawerCategory):', err));
    };

    // ─── Patch renameDrawerCategory ───
    const _origRenameCat = api.renameDrawerCategory.bind(api);
    api.renameDrawerCategory = function(key, newLabel) {
      _lastCategoryWrite = Date.now();
      _origRenameCat(key, newLabel);
      const cat = store.drawerCategories[key];
      if (cat) {
        // P2-5: only send id + label + color. The old payload wrote the UUID
        // into the text `key` column via cat.id. saveDrawerCategory's update
        // path no longer touches `key` at all.
        DB.saveDrawerCategory({ id: key, label: cat.label, color: cat.color })
          .catch(err => console.error('Sync error (renameDrawerCategory):', err));
      }
    };

    // ─── Patch deleteDrawerCategory ───
    const _origDelCat = api.deleteDrawerCategory.bind(api);
    api.deleteDrawerCategory = function(key) {
      _lastCategoryWrite = Date.now();
      _origDelCat(key);
      DB.deleteDrawerCategory(key)
        .catch(err => console.error('Sync error (deleteDrawerCategory):', err));
    };

    // ─── Patch surfaceDrawerTasks ───
    const _origSurface = api.surfaceDrawerTasks.bind(api);
    api.surfaceDrawerTasks = function() {
      const surfaced = _origSurface();
      surfaced.forEach(t => persistTask(t));
      return surfaced;
    };

    // ─── Expose sync-safe task save for use outside patched API methods ───
    // Used by schedule popover, notes card title edit, cardClearDate, etc.
    // Must be inside patchApiForSync() so persistTask is in scope.
    window._syncSaveTask = function(task) {
      if (!task) return;
      _markWritten(task.id);
      persistTask(task);
    };

    // ─── Flush delayed-write windows immediately (before tab hide/close) ───
    // Two writes are deferred: the 300ms add-task timer (task._pendingSaveTimer)
    // and the notes debounce. On mobile the tab is often killed while hidden,
    // firing neither. This drains both synchronously so nothing is lost.
    window._flushPendingSaves = function() {
      store.tasks.forEach(t => {
        if (t._pendingSaveTimer) {
          clearTimeout(t._pendingSaveTimer);
          delete t._pendingSaveTimer;
          persistTask(t);   // persistTask re-marks + saves the live task
        }
      });
      if (window._flushNotesSave) window._flushNotesSave();
    };

    console.log('✓ Sync layer active — mutations will persist to Supabase');
  }

  // ─── Patch saveCurrentNotes ───
  function patchNotesSave() {
    if (typeof saveCurrentNotes === 'undefined') {
      setTimeout(patchNotesSave, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) return;

    const _origSaveNotes = window.saveCurrentNotes;

    // The actual DB write for the currently-open notes task. Shared by the
    // debounced timer and the immediate flush-on-hide path.
    function _doNotesSave() {
      if (typeof currentNotesTaskId === 'undefined' || currentNotesTaskId === null) return;
      const task = store.tasks.find(t => t.id === currentNotesTaskId);
      if (!task) return;
      _markWritten(task.id);
      _inFlightSaves++;
      DB.saveTask(task).then(saved => {
        _inFlightSaves--;
        if (saved) { _markWritten(saved.id); return; }
        // Silent failure — queue a retry so the notes edit isn't lost.
        console.error('Sync error (notes returned null), queueing retry:', task.title);
        _queueRetry(task.id);
        _scheduleFlush();
      }).catch(err => {
        _inFlightSaves--;
        console.error('Sync error (notes), queueing retry:', err);
        _queueRetry(task.id);
        _scheduleFlush();
      });
    }

    // Flush the pending notes debounce immediately (used before tab kill).
    window._flushNotesSave = function() {
      clearTimeout(window._notesSyncTimer);
      window._notesSyncTimer = null;
      _doNotesSave();
    };

    window.saveCurrentNotes = function() {
      _origSaveNotes();
      clearTimeout(window._notesSyncTimer);
      // 800ms (was 2000ms): notes saves are cheap row updates; a shorter
      // debounce narrows the window where a tab kill loses the edit.
      window._notesSyncTimer = setTimeout(_doNotesSave, 800);
    };
  }

  // ─── Patch logCompletion ───
  function patchBumpCounter() {
    if (typeof bumpCounter === 'undefined') {
      setTimeout(patchBumpCounter, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) return;

    if (typeof logCompletion !== 'undefined') {
      const _origLog = window.logCompletion;
      window.logCompletion = function(taskId) {
        // _origLog pushes {ts, id (client uuid), taskId} and returns it.
        const entry = _origLog(taskId);
        if (!entry || !entry.id) { _lastCompletionWrite = Date.now(); return; }
        const eventId = entry.id;
        // Mark by event id BEFORE the insert so the realtime INSERT echo is
        // suppressed by id (P2-1).
        if (window._markCompletionEventWrite) window._markCompletionEventWrite(eventId);
        // Durable + tracked: stash in the outbox and count as in-flight so a
        // refresh can't wipe the local completion log before this lands, and a
        // tab discard can't lose the Hall-of-Fame entry.
        _outboxAddCompletion(entry);
        _inFlightSaves++;
        DB.saveCompletionEvent(taskId, eventId).then(saved => {
          _inFlightSaves--;
          if (saved) _outboxRemoveCompletion(eventId);
          else _scheduleFlush();   // stays in the outbox; retried later
        }).catch(err => {
          _inFlightSaves--;
          console.error('Sync error (logCompletion), will retry:', err);
          _scheduleFlush();
        });
      };
    }
  }

  // Start patching after a short delay to ensure app.js has loaded
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      patchApiForSync();
      patchNotesSave();
      patchBumpCounter();
    }, 100);
  });

})();
