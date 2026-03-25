// TinyApe Database Layer
// Provides async database functions using Supabase client

window.TinyApeDB = {
  /**
   * Get current user ID from auth session
   * @private
   * @returns {Promise<string|null>} User ID or null
   */
  async _getUserId() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const { data: { user }, error } = await window.supabase.auth.getUser();

      if (error || !user) {
        console.error('Error getting user:', error);
        return null;
      }

      return user.id;
    } catch (err) {
      console.error('Unexpected error getting user ID:', err);
      return null;
    }
  },

  /**
   * Map database column names (snake_case) to JavaScript property names (camelCase)
   * @private
   */
  _mapDbTaskToJs(dbTask) {
    if (!dbTask) return null;

    return {
      id: dbTask.id,
      title: dbTask.title,
      category: dbTask.category,
      today: dbTask.today,
      todayOrder: dbTask.today_order,
      done: dbTask.done,
      completedAt: dbTask.completed_at,
      recurring: dbTask.recurring,
      recurDays: dbTask.recur_days,
      dueDate: dbTask.due_date,
      projectId: dbTask.project_id,
      notes: dbTask.notes,
      drawer: dbTask.drawer,
      drawerCategory: dbTask.drawer_category,
      isProject: dbTask.is_project,
      trackTime: dbTask.track_time || false,
      projectOrder: dbTask.project_order,
      timeSessions: dbTask.time_sessions || [],
      killedAt: dbTask.killed_at,
      createdAt: dbTask.created_at,
      updatedAt: dbTask.updated_at,
      userId: dbTask.user_id
    };
  },

  /**
   * Map JavaScript property names (camelCase) to database column names (snake_case)
   * @private
   */
  _mapJsTaskToDb(jsTask) {
    if (!jsTask) return null;

    // Only include columns that exist in the Supabase tasks table
    const mapped = {
      title: jsTask.title,
      today: jsTask.today,
      today_order: jsTask.todayOrder,
      done: jsTask.done,
      completed_at: jsTask.completedAt,
      recurring: jsTask.recurring,
      recur_days: jsTask.recurDays,
      due_date: jsTask.dueDate,
      notes: jsTask.notes,
      drawer: jsTask.drawer,
      drawer_category: jsTask.drawerCategory,
      is_project: jsTask.isProject,
      track_time: jsTask.trackTime || false,
      project_order: jsTask.projectOrder,
      killed: jsTask.killed || false,
      killed_at: jsTask.killedAt
    };
    // Include id and user_id only if present (not for new inserts)
    if (jsTask.id && typeof jsTask.id === 'string') mapped.id = jsTask.id;
    if (jsTask.userId) mapped.user_id = jsTask.userId;
    return mapped;
  },

  /**
   * Load all data for current user (tasks, categories, completion events, creature unlocks)
   * @returns {Promise<Object>} { tasks, killedTasks, drawerCategories, completionLog, creatureUnlocks }
   */
  async loadAllData() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return { tasks: [], killedTasks: [], drawerCategories: {}, completionLog: [], creatureUnlocks: [] };
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return { tasks: [], killedTasks: [], drawerCategories: {}, completionLog: [], creatureUnlocks: [] };
      }

      // Load tasks
      const { data: tasksData, error: tasksError } = await window.supabase
        .from('tasks')
        .select('*')
        .eq('user_id', userId)
        .order('today_order', { ascending: true, nullsFirst: true });

      if (tasksError) {
        console.error('Error loading tasks:', tasksError);
      }

      // Separate active and killed tasks
      const tasks = [];
      const killedTasks = [];

      (tasksData || []).forEach(dbTask => {
        const jsTask = this._mapDbTaskToJs(dbTask);
        if (dbTask.killed) {
          killedTasks.push(jsTask);
        } else {
          tasks.push(jsTask);
        }
      });

      // Load drawer categories
      const { data: categoriesData, error: categoriesError } = await window.supabase
        .from('drawer_categories')
        .select('*')
        .eq('user_id', userId);

      if (categoriesError) {
        console.error('Error loading drawer categories:', categoriesError);
      }

      const drawerCategories = {};
      (categoriesData || []).forEach(cat => {
        drawerCategories[cat.id] = {
          id: cat.id,
          label: cat.label,
          color: cat.color
        };
      });

      // Load completion events
      const { data: completionData, error: completionError } = await window.supabase
        .from('completion_events')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: true });

      if (completionError) {
        console.error('Error loading completion events:', completionError);
      }

      const completionLog = (completionData || []).map(evt => ({
        ts: evt.created_at,
        id: evt.id
      }));

      // Load creature unlocks
      const { data: creatureData, error: creatureError } = await window.supabase
        .from('creature_unlocks')
        .select('*')
        .eq('user_id', userId)
        .order('unlocked_at', { ascending: true });

      if (creatureError) {
        console.error('Error loading creature unlocks:', creatureError);
      }

      const creatureUnlocks = (creatureData || []).map(unlock => ({
        creatureIndex: unlock.creature_index,
        unlockedAt: unlock.unlocked_at,
        id: unlock.id
      }));

      return {
        tasks,
        killedTasks,
        drawerCategories,
        completionLog,
        creatureUnlocks
      };
    } catch (err) {
      console.error('Unexpected error loading all data:', err);
      return { tasks: [], killedTasks: [], drawerCategories: {}, completionLog: [], creatureUnlocks: [] };
    }
  },

  /**
   * Save or update a task
   * @param {Object} task - Task object with camelCase properties
   * @returns {Promise<Object|null>} Saved task (mapped to camelCase) or null
   */
  async saveTask(task) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return null;
      }

      // Map to DB format and add user_id
      const dbTask = this._mapJsTaskToDb(task);
      dbTask.user_id = userId;

      let result;

      // Local-only tasks have integer IDs; DB tasks have UUID strings
      const isDbTask = task.id && typeof task.id === 'string';

      if (isDbTask) {
        // Update existing task
        const { data, error } = await window.supabase
          .from('tasks')
          .update(dbTask)
          .eq('id', task.id)
          .eq('user_id', userId)
          .select();

        if (error) {
          console.error('Error updating task:', error);
          return null;
        }

        result = data;
      } else {
        // Insert new task
        const { data, error } = await window.supabase
          .from('tasks')
          .insert([dbTask])
          .select();

        if (error) {
          console.error('Error inserting task:', error);
          return null;
        }

        result = data;
      }

      if (result && result.length > 0) {
        return this._mapDbTaskToJs(result[0]);
      }

      return null;
    } catch (err) {
      console.error('Unexpected error saving task:', err);
      return null;
    }
  },

  /**
   * Delete a task from the database
   * @param {string} taskId - Task ID
   * @returns {Promise<boolean>} True if deleted, false otherwise
   */
  async deleteTask(taskId) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return false;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return false;
      }

      const { error } = await window.supabase
        .from('tasks')
        .delete()
        .eq('id', taskId)
        .eq('user_id', userId);

      if (error) {
        console.error('Error deleting task:', error);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Unexpected error deleting task:', err);
      return false;
    }
  },

  /**
   * Save a completion event (task completion)
   * @returns {Promise<Object|null>} Saved event or null
   */
  async saveCompletionEvent() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return null;
      }

      const { data, error } = await window.supabase
        .from('completion_events')
        .insert([{
          user_id: userId,
          created_at: new Date().toISOString()
        }])
        .select();

      if (error) {
        console.error('Error saving completion event:', error);
        return null;
      }

      if (data && data.length > 0) {
        return {
          ts: data[0].created_at,
          id: data[0].id
        };
      }

      return null;
    } catch (err) {
      console.error('Unexpected error saving completion event:', err);
      return null;
    }
  },

  /**
   * Load Hall of Fame best days from view
   * @returns {Promise<Array>} Array of best days
   */
  async loadHallOfFameDays() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return [];
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return [];
      }

      const { data, error } = await window.supabase
        .from('hall_of_fame_days')
        .select('*')
        .eq('user_id', userId)
        .order('completion_count', { ascending: false })
        .limit(5);

      if (error) {
        console.error('Error loading Hall of Fame days:', error);
        return [];
      }

      return data || [];
    } catch (err) {
      console.error('Unexpected error loading Hall of Fame days:', err);
      return [];
    }
  },

  /**
   * Load Hall of Fame best weeks from view
   * @returns {Promise<Array>} Array of best weeks
   */
  async loadHallOfFameWeeks() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return [];
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return [];
      }

      const { data, error } = await window.supabase
        .from('hall_of_fame_weeks')
        .select('*')
        .eq('user_id', userId)
        .order('completion_count', { ascending: false })
        .limit(5);

      if (error) {
        console.error('Error loading Hall of Fame weeks:', error);
        return [];
      }

      return data || [];
    } catch (err) {
      console.error('Unexpected error loading Hall of Fame weeks:', err);
      return [];
    }
  },

  /**
   * Save or update a drawer category
   * @param {Object} category - Category object { id, label, color }
   * @returns {Promise<Object|null>} Saved category or null
   */
  async saveDrawerCategory(category) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return null;
      }

      const catData = {
        key: category.key,
        label: category.label,
        color: category.color,
        user_id: userId
      };

      let result;

      if (category.id) {
        // Update existing category
        const { data, error } = await window.supabase
          .from('drawer_categories')
          .update(catData)
          .eq('id', category.id)
          .eq('user_id', userId)
          .select();

        if (error) {
          console.error('Error updating drawer category:', error);
          return null;
        }

        result = data;
      } else {
        // Insert new category (upsert to avoid conflict if it already exists)
        const { data, error } = await window.supabase
          .from('drawer_categories')
          .upsert([catData], { onConflict: 'user_id,key' })
          .select();

        if (error) {
          console.error('Error inserting drawer category:', error);
          return null;
        }

        result = data;
      }

      if (result && result.length > 0) {
        return {
          id: result[0].id,
          label: result[0].label,
          color: result[0].color
        };
      }

      return null;
    } catch (err) {
      console.error('Unexpected error saving drawer category:', err);
      return null;
    }
  },

  /**
   * Delete a drawer category
   * @param {string} categoryId - Category ID
   * @returns {Promise<boolean>} True if deleted, false otherwise
   */
  async deleteDrawerCategory(categoryId) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return false;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return false;
      }

      const { error } = await window.supabase
        .from('drawer_categories')
        .delete()
        .eq('id', categoryId)
        .eq('user_id', userId);

      if (error) {
        console.error('Error deleting drawer category:', error);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Unexpected error deleting drawer category:', err);
      return false;
    }
  },

  /**
   * Save a creature unlock
   * @param {number} creatureIndex - Index of creature (0-48)
   * @returns {Promise<Object|null>} Saved unlock record or null
   */
  async saveCreatureUnlock(creatureIndex) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return null;
      }

      const { data, error } = await window.supabase
        .from('creature_unlocks')
        .insert([{
          user_id: userId,
          creature_index: creatureIndex,
          unlocked_at: new Date().toISOString()
        }])
        .select();

      if (error) {
        console.error('Error saving creature unlock:', error);
        return null;
      }

      if (data && data.length > 0) {
        return {
          creatureIndex: data[0].creature_index,
          unlockedAt: data[0].unlocked_at,
          id: data[0].id
        };
      }

      return null;
    } catch (err) {
      console.error('Unexpected error saving creature unlock:', err);
      return null;
    }
  },

  /**
   * Load all creature unlocks for current user
   * @returns {Promise<Array>} Array of creature unlocks
   */
  async loadCreatureUnlocks() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return [];
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return [];
      }

      const { data, error } = await window.supabase
        .from('creature_unlocks')
        .select('*')
        .eq('user_id', userId)
        .order('unlocked_at', { ascending: true });

      if (error) {
        console.error('Error loading creature unlocks:', error);
        return [];
      }

      return (data || []).map(unlock => ({
        creatureIndex: unlock.creature_index,
        unlockedAt: unlock.unlocked_at,
        id: unlock.id
      }));
    } catch (err) {
      console.error('Unexpected error loading creature unlocks:', err);
      return [];
    }
  },

  /**
   * Save a time session for a project
   * @param {Object} session - Session object { taskId, date, minutes, note }
   * @returns {Promise<Object|null>} Saved session or null
   */
  async saveTimeSession(session) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return null;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return null;
      }

      const sessionData = {
        user_id: userId,
        task_id: session.taskId,
        session_date: session.date,
        duration_minutes: session.minutes,
        note: session.note || ''
      };

      const { data, error } = await window.supabase
        .from('time_sessions')
        .insert([sessionData])
        .select();

      if (error) {
        console.error('Error saving time session:', error);
        return null;
      }

      if (data && data.length > 0) {
        return {
          id: data[0].id,
          taskId: data[0].task_id,
          date: data[0].session_date,
          minutes: data[0].duration_minutes,
          note: data[0].note
        };
      }

      return null;
    } catch (err) {
      console.error('Unexpected error saving time session:', err);
      return null;
    }
  },

  /**
   * Delete a time session
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>} True if deleted, false otherwise
   */
  async deleteTimeSession(sessionId) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return false;
      }

      const userId = await this._getUserId();
      if (!userId) {
        console.error('No user logged in');
        return false;
      }

      const { error } = await window.supabase
        .from('time_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', userId);

      if (error) {
        console.error('Error deleting time session:', error);
        return false;
      }

      return true;
    } catch (err) {
      console.error('Unexpected error deleting time session:', err);
      return false;
    }
  }
};
