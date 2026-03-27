// TinyApe Sync Layer (v2 — Realtime-first)
// ──────────────────────────────────────────
// Local-first: in-memory store is always fast, DB writes are async.
// Supabase Realtime pushes row-level changes from other devices.
// Echo suppression prevents our own writes from triggering re-renders.
// Failed writes are queued and retried automatically.

(function() {
  'use strict';

  // ─── RETRY QUEUE ───
  const pendingWrites = [];  // [{ task: {...}, retries: 0 }]
  const MAX_RETRIES = 10;
  let _inFlightSaves = 0;

  // ─── ECHO SUPPRESSION ───
  // When we write to DB, the realtime subscription will echo that change back.
  // We track recent writes so the realtime handler can skip our own changes.
  const _recentWrites = new Map();    // id (string) -> timestamp
  let _lastCompletionWrite = 0;       // timestamp of last completion event write/delete
  let _lastCategoryWrite = 0;         // timestamp of last category write/delete

  function _markWritten(id) {
    if (id == null) return;
    _recentWrites.set(String(id), Date.now());
    // Prune entries older than 15 seconds
    if (_recentWrites.size > 50) {
      for (const [key, ts] of _recentWrites) {
        if (Date.now() - ts > 15000) _recentWrites.delete(key);
      }
    }
  }

  // ─── EXPOSED HELPERS ───

  window._syncQueue = pendingWrites;  // for debugging

  // Resolve a task ID that might be stale (integer ID replaced by UUID).
  window._findTaskById = function(id) {
    return store.tasks.find(t => t.id === id || t._localId === id);
  };

  window._hasPendingWrites = function() {
    return pendingWrites.length > 0 || _inFlightSaves > 0;
  };

  // Check if it's safe to do a FULL refresh from DB
  // (used by the infrequent fallback poll and tab-focus refresh)
  window._isSafeToSync = function() {
    if (_inFlightSaves > 0) return false;
    if (pendingWrites.length > 0) return false;
    if (store.tasks.some(t => t._pendingSaveTimer)) return false;
    return true;
  };

  // Flush all pending writes to Supabase (called before full refresh)
  window._flushSyncQueue = async function() {
    if (pendingWrites.length === 0) return;

    const DB = window.TinyApeDB;
    if (!DB) return;

    const batch = pendingWrites.splice(0, pendingWrites.length);
    const stillFailing = [];

    for (const entry of batch) {
      try {
        const saved = await DB.saveTask(entry.task);
        if (saved && saved.id !== entry.task.id) {
          const localTask = store.tasks.find(t => t.id === entry.task.id);
          if (localTask) localTask.id = saved.id;
          entry.task.id = saved.id;
        }
        _markWritten(saved ? saved.id : entry.task.id);
      } catch (err) {
        console.error('Retry failed for task:', entry.task.title, err);
        entry.retries++;
        if (entry.retries < MAX_RETRIES) {
          stillFailing.push(entry);
        } else {
          console.error('Giving up on task after max retries:', entry.task.title);
        }
      }
    }

    stillFailing.forEach(e => pendingWrites.push(e));
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
    pendingWrites.forEach(e => unsaved.add(e.task.id));
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

    // Helper: persist a task to Supabase (with retry on failure)
    function persistTask(task) {
      if (!task) return;
      // Cancel any pending delayed save from addTask (prevents double INSERT)
      if (task._pendingSaveTimer) {
        clearTimeout(task._pendingSaveTimer);
        delete task._pendingSaveTimer;
      }
      // Mark BEFORE save so echo suppression covers the entire round-trip
      _markWritten(task.id);
      _inFlightSaves++;
      DB.saveTask(task).then(saved => {
        _inFlightSaves--;
        if (saved) {
          _markWritten(saved.id);  // also mark the UUID (may differ from local ID)
          if (saved.id !== task.id) {
            const oldId = task.id;
            task._localId = oldId;
            task.id = saved.id;
            _markWritten(saved.id);
          }
        }
      }).catch(err => {
        _inFlightSaves--;
        console.error('Sync error (saveTask), queueing retry:', err);
        const existing = pendingWrites.find(e => e.task.id === task.id);
        if (existing) {
          existing.task = { ...task };
        } else {
          pendingWrites.push({ task: { ...task }, retries: 0 });
        }
      });
    }

    // Helper: persist all today tasks (for reorder)
    function persistTodayOrder() {
      const todayTasks = store.tasks.filter(t => t.today && !t.done);
      todayTasks.forEach(t => persistTask(t));
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
      console.log('[Sync:DELETE] Killing task:', id, task ? task.title : '(not found)', 'drawer:', task && task.drawer);
      _markWritten(id);
      _origDeleteTask(id);
      if (task) {
        _inFlightSaves++;
        const killedVersion = store.killedTasks.find(t => t.killedAt &&
          (t.id === id || t.title === task.title));
        const toSave = killedVersion
          ? { ...killedVersion, killed: true }
          : { ...task, killed: true, killedAt: new Date().toISOString() };
        console.log('[Sync:DELETE] Saving to DB with killed:true, id:', toSave.id);
        DB.saveTask(toSave).then(saved => {
          _inFlightSaves--;
          if (saved) {
            _markWritten(saved.id);
            console.log('[Sync:DELETE] ✅ DB confirmed kill:', saved.id, saved.title, 'killed:', saved.killed);
          } else {
            console.error('[Sync:DELETE] ❌ DB returned null — save may have failed silently!');
          }
        }).catch(err => {
          _inFlightSaves--;
          console.error('[Sync:DELETE] ❌ DB error:', err);
          pendingWrites.push({ task: toSave, retries: 0 });
        });
      } else {
        console.error('[Sync:DELETE] ❌ Task not found in store.tasks! ID:', id);
      }
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
        .catch(err => console.error('Sync error (addTimeSession):', err));
      return task;
    };

    // ─── Patch deleteTimeSession ───
    const _origDelTime = api.deleteTimeSession.bind(api);
    api.deleteTimeSession = function(id, idx) {
      _origDelTime(id, idx);
      const task = store.tasks.find(t => t.id === id);
      persistTask(task);
    };

    // ─── Patch toggleDone ───
    const _origToggleDone = api.toggleDone.bind(api);
    api.toggleDone = function(id) {
      const task = _origToggleDone(id);
      persistTask(task);
      if (task && task.done) {
        // completion event saved via logCompletion patch (called by bumpCounter)
        persistTodayOrder();
        const respawned = store.tasks.find(t =>
          t.title === task.title && !t.done && t.id !== task.id && t.recurring);
        if (respawned) persistTask(respawned);
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
          const task = store.tasks.find(t => t.id === id);
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
        .catch(err => console.error('Sync error (addDrawerCategory):', err));
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

    console.log('✓ Sync layer active — mutations will persist to Supabase');
  }

  // ─── Expose sync-safe task save for use outside patched API methods ───
  // Used by closeNotesCard to persist title/notes edits through the sync layer
  // instead of calling TinyApeDB.saveTask directly (which bypasses echo suppression).
  window._syncSaveTask = function(task) {
    if (!task) return;
    _markWritten(task.id);
    persistTask(task);
  };

  // ─── Patch saveCurrentNotes ───
  function patchNotesSave() {
    if (typeof saveCurrentNotes === 'undefined') {
      setTimeout(patchNotesSave, 50);
      return;
    }

    const DB = window.TinyApeDB;
    if (!DB) return;

    const _origSaveNotes = window.saveCurrentNotes;
    window.saveCurrentNotes = function() {
      _origSaveNotes();
      clearTimeout(window._notesSyncTimer);
      window._notesSyncTimer = setTimeout(() => {
        if (typeof currentNotesTaskId !== 'undefined' && currentNotesTaskId !== null) {
          const task = store.tasks.find(t => t.id === currentNotesTaskId);
          if (task) {
            _markWritten(task.id);
            _inFlightSaves++;
            DB.saveTask(task).then(saved => {
              _inFlightSaves--;
              if (saved) _markWritten(saved.id);
            }).catch(err => {
              _inFlightSaves--;
              console.error('Sync error (notes), queueing retry:', err);
              pendingWrites.push({ task: { ...task }, retries: 0 });
            });
          }
        }
      }, 2000);
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
      window.logCompletion = function() {
        _origLog();
        _lastCompletionWrite = Date.now();
        DB.saveCompletionEvent().catch(err =>
          console.error('Sync error (logCompletion):', err));
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
