// TinyApe Authentication Module
// Provides Supabase auth functionality without ES modules

window.TinyApeAuth = {
  user: null,
  authStateCallbacks: [],

  /**
   * Initialize Supabase client and check for existing session
   * @returns {Promise<Object|null>} Current user or null
   */
  async initAuth() {
    try {
      // Import Supabase from CDN
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');

      // Create and attach client to window
      window.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

      // Check for existing session
      const { data: { session }, error } = await window.supabase.auth.getSession();

      if (error) {
        console.error('Error getting session:', error);
        return null;
      }

      if (session && session.user) {
        this.user = session.user;
        this._notifyAuthStateChange(session.user);
        return session.user;
      }

      return null;
    } catch (err) {
      console.error('Error initializing auth:', err);
      return null;
    }
  },

  /**
   * Sign in with magic link (OTP)
   * @param {string} email - User email
   * @returns {Promise<Object>} Result with success/error
   */
  async signIn(email) {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return { success: false, error: 'Supabase not initialized' };
      }

      const { error } = await window.supabase.auth.signInWithOtp({
        email: email,
        options: {
          emailRedirectTo: window.location.origin
        }
      });

      if (error) {
        console.error('Sign in error:', error);
        return { success: false, error: error.message };
      }

      return { success: true, message: 'Check your email for the magic link' };
    } catch (err) {
      console.error('Unexpected sign in error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Sign out current user
   * @returns {Promise<Object>} Result with success/error
   */
  async signOut() {
    try {
      if (!window.supabase) {
        console.error('Supabase not initialized');
        return { success: false, error: 'Supabase not initialized' };
      }

      const { error } = await window.supabase.auth.signOut();

      if (error) {
        console.error('Sign out error:', error);
        return { success: false, error: error.message };
      }

      this.user = null;
      this._notifyAuthStateChange(null);
      return { success: true };
    } catch (err) {
      console.error('Unexpected sign out error:', err);
      return { success: false, error: err.message };
    }
  },

  /**
   * Get current user
   * @returns {Object|null} Current user or null
   */
  getUser() {
    return this.user;
  },

  /**
   * Listen for auth state changes
   * @param {Function} callback - Called with (user) when auth state changes
   * @returns {Function} Unsubscribe function
   */
  onAuthStateChange(callback) {
    this.authStateCallbacks.push(callback);

    // Also set up Supabase listener if available
    if (window.supabase) {
      return window.supabase.auth.onAuthStateChange((event, session) => {
        const user = session?.user || null;
        this.user = user;
        this._notifyAuthStateChange(user);
      });
    }

    // Return an unsubscribe function
    return () => {
      this.authStateCallbacks = this.authStateCallbacks.filter(cb => cb !== callback);
    };
  },

  /**
   * Internal: Notify all listeners of auth state change
   * @private
   */
  _notifyAuthStateChange(user) {
    this.authStateCallbacks.forEach(callback => {
      try {
        callback(user);
      } catch (err) {
        console.error('Error in auth state callback:', err);
      }
    });
  }
};
