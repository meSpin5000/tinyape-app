// TinyApe Sync Layer
// Wraps in-memory API mutations with Supabase persistence
// Operates "local-first" — the in-memory store is always fast,
// and DB writes happen async in the background.
// Failed writes are queued and retried automatically.

(function() {
  'use strict';

  // ─── RETRY QUEUE ───
  // Tasks that failed to save to Supabase get queued here for retry
  const pendingWrites = [];  // [{ task: {...}, retries: 0 }]
  const MAX_RETRIES = 10;

  window._syncQueue = pendingWrites;  // expose for debugging

  // Check if there are unsaved local changes
  window._hasPendingWrites = function() {
    return pendingWrites.length > 0;
  };

  // Flush all pending writes to Supabase (called before refresh)
  window._flushSyncQueue = async function() {
    if (pendingWrites.length === 0) return;

    const DB = window.TinyApeDB;
    if (!DB) return;

    // Work through a copy so we can safely modify the queue
    const batch = pendingWrites.splice(0, pendingWrites.length);
    const stillFailing = [];

    for (const entry of batch) {
      try {
        const saved = await DB.saveTask(entry.task);
        if (saved && saved.id !== entry.task.id) {
          // Update local ID with the DB UUID
          const localTask = store.tasks.find(t => t.id === entry.task.id);
          if (localTask) localTask.id = saved.id;
          entry.task.id = saved.id;
        }
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

    // Put failures back in the queue
    stillFailing.forEach(e => pendingWrites.push(e));
  };

  // Get IDs of tasks that only exist locally (never saved to DB)
  // These have local integer IDs rather than DB UUIDs
  window._getUnsavedTaskIds = function() {
    const unsaved = new Set();
    // Local-only tasks have integer IDs (from store.nextId)
    // DB tasks have UUID strings
    store.tasks.forEach(t => {
      if (typeof t.id === 'number') unsaved.add(t.id);
    });
    // Also include any tasks in the pending writes queue
    pendingWrites.forEach(e => unsaved.add(e.task.id));
    return unsaved;
  };

  // Wait for app.js to define `api` and `store`, then patch mutations
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
      DB.saveTask(task).then(saved => {
        if (saved && saved.id !== task.id) {
          // Update local ID with DB UUID
          task.id = saved.id;
        }
      }).catch(err => {
        console.error('Sync error (saveTask), queueing retry:', err);
        // Check if this task is already in the retry queue
        const existing = pendingWrites.find(e => e.task.id === task.id);
        if (existing) {
          existing.task = { ...task };  // update with latest state
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
      DB.saveTask(task).then(saved => {
        if (saved && saved.id !== task.id) {
          task.id = saved.id;
        }
      }).catch(err => {
        console.error('Sync error (addTask), queueing retry:', err);
        pendingWrites.push({ task: { ...task }, retries: 0 });
      });
      return task;
    };

    // ─── Patch deleteTask ───
    const _origDeleteTask = api.deleteTask.bind(api);
    api.deleteTask = function(id) {
      const task = store.tasks.find(t => t.id === id);
      _origDeleteTask(id);
      if (task) {
        const killedVersion = store.killedTasks.find(t => t.killedAt &&
          (t.id === id || t.title === task.title));
        if (killedVersion) {
          DB.saveTask({ ...killedVersion, killed: true }).catch(err => {
            console.error('Sync error (deleteTask), queueing retry:', err);
            pendingWrites.push({ task: { ...killedVersion, killed: true }, retries: 0 });
          });
        } else {
          const killedTask = { ...task, killed: true, killedAt: new Date().toISOString() };
          DB.saveTask(killedTask).catch(err => {
            console.error('Sync error (deleteTask), queueing retry:', err);
            pendingWrites.push({ task: killedTask, retries: 0 });
          });
        }
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
        DB.saveCompletionEvent().catch(err =>
          console.error('Sync error (completionEvent):', err));
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

    // ─── Patch reorderToday (the public drag version) ───
    if (api.reorderToday) {
      const _origReorderPublic = api.reorderToday.bind(api);
      api.reorderToday = function(orderedIds) {
        _origReorderPublic(orderedIds);
        persistTodayOrder();
      };
    }

    // ─── Patch addDrawerCategory ───
    const _origAddCat = api.addDrawerCategory.bind(api);
    api.addDrawerCategory = function(key, label, color) {
      _origAddCat(key, label, color);
      DB.saveDrawerCategory({ key, label, color, sortOrder: Object.keys(store.drawerCategories).length })
        .catch(err => console.error('Sync error (addDrawerCategory):', err));
    };

    // ─── Patch deleteDrawerCategory ───
    const _origDelCat = api.deleteDrawerCategory.bind(api);
    api.deleteDrawerCategory = function(key) {
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

  // Also patch saveCurrentNotes to persist after notes edit
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
            DB.saveTask(task).catch(err => {
              console.error('Sync error (notes), queueing retry:', err);
              pendingWrites.push({ task: { ...task }, retries: 0 });
            });
          }
        }
      }, 2000);
    };
  }

  // Patch bumpCounter to log completion events
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
