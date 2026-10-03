//! Which agents finished or asked for something while the person was looking
//! elsewhere. The app says which agents it shows; the rest are left unread
//! until it shows them.

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

use super::connection::ClientId;

#[derive(Default)]
struct State {
    unread: HashSet<String>,
    on_screen: HashSet<String>,
    /// The app connection that said what is on screen; nothing is once it goes.
    shown_by: Option<ClientId>,
}

#[derive(Default)]
pub(crate) struct Seen {
    state: Mutex<State>,
}

impl Seen {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The agent went back to work, so what it last finished is old news.
    pub(crate) fn working(&self, agent_id: &str) {
        self.lock().unread.remove(agent_id);
    }

    /// The agent finished a turn or is waiting on the person.
    pub(crate) fn wants_a_look(&self, agent_id: &str) {
        let mut state = self.lock();
        if !state.on_screen.contains(agent_id) {
            state.unread.insert(agent_id.to_owned());
        }
    }

    pub(crate) fn on_screen(&self, client: ClientId, agent_ids: Vec<String>) {
        let mut state = self.lock();
        state.on_screen = agent_ids.into_iter().collect();
        state.shown_by = Some(client);
        let State {
            unread, on_screen, ..
        } = &mut *state;
        unread.retain(|agent_id| !on_screen.contains(agent_id));
    }

    pub(crate) fn client_gone(&self, client: ClientId) {
        let mut state = self.lock();
        if state.shown_by == Some(client) {
            state.on_screen.clear();
            state.shown_by = None;
        }
    }

    pub(crate) fn unread(&self, agent_id: &str) -> bool {
        self.lock().unread.contains(agent_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_off_screen_stays_unread_until_it_is_shown_or_works_again() {
        let seen = Seen::default();
        seen.wants_a_look("a");
        assert!(seen.unread("a"));
        seen.working("a");
        assert!(!seen.unread("a"));
        seen.wants_a_look("a");
        seen.on_screen(1, vec!["a".into()]);
        assert!(!seen.unread("a"));
    }

    #[test]
    fn an_agent_on_screen_is_never_left_unread() {
        let seen = Seen::default();
        seen.on_screen(1, vec!["a".into()]);
        seen.wants_a_look("a");
        assert!(!seen.unread("a"));
        seen.on_screen(1, Vec::new());
        seen.wants_a_look("a");
        assert!(seen.unread("a"));
    }

    #[test]
    fn nothing_is_on_screen_once_the_app_that_showed_it_goes() {
        let seen = Seen::default();
        seen.on_screen(1, vec!["a".into()]);
        seen.client_gone(2);
        seen.wants_a_look("a");
        assert!(!seen.unread("a"));
        seen.client_gone(1);
        seen.wants_a_look("a");
        assert!(seen.unread("a"));
    }
}
