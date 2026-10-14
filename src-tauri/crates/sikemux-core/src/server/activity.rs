//! What an agent just did, told once to both the person's unread marks and
//! the phones' notifications, for chats and agents in terminals alike.

use super::follow::Happened;
use super::notify::Signal;
use super::Core;

pub(crate) enum Activity<'a> {
    /// It began a turn of work.
    Started,
    /// It is still at the work it began.
    Working,
    /// Its turn ended. One the person stopped is nothing new to them.
    Finished { cancelled: bool },
    /// It waits on the person.
    NeedsYou,
    /// It ran into a problem, and said this about it.
    Problem(&'a str),
}

impl Core {
    pub(crate) fn note_activity(&self, agent_id: &str, activity: Activity<'_>) {
        let happened = match activity {
            Activity::Started => Some(Happened::Working),
            Activity::Working => None,
            Activity::Finished { cancelled: false } => Some(Happened::Done),
            Activity::Finished { cancelled: true } => Some(Happened::Stopped),
            Activity::NeedsYou => Some(Happened::NeedsYou),
            Activity::Problem(_) => Some(Happened::Failed),
        };
        if let Some(happened) = happened {
            self.journal_agent(agent_id, happened);
        }
        let agent_id = agent_id.to_owned();
        match activity {
            Activity::Started => {
                self.seen.started(&agent_id);
                self.inbox.started(&agent_id);
                self.notify.send(Signal::TurnStarted { agent_id });
            }
            Activity::Working => self.seen.working(&agent_id),
            Activity::Finished { cancelled } => {
                super::questions::turn_ended(self, &agent_id);
                if cancelled {
                    self.seen.active(&agent_id);
                    self.inbox.stopped(&agent_id);
                } else {
                    self.seen.wants_a_look(&agent_id);
                    self.inbox.ended(&agent_id, None);
                }
                self.notify.send(Signal::TurnCompleted {
                    agent_id,
                    cancelled,
                });
            }
            Activity::NeedsYou => self.seen.wants_a_look(&agent_id),
            Activity::Problem(message) => {
                self.seen.wants_a_look(&agent_id);
                self.inbox.ended(&agent_id, Some(message));
                self.notify.send(Signal::Problem {
                    agent_id,
                    message: message.to_owned(),
                });
            }
        }
    }

    /// The agent stopped running, whether it ended by itself or was closed.
    pub(crate) fn note_agent_gone(&self, agent_id: &str) {
        self.journal_agent(agent_id, Happened::Gone);
    }

    fn journal_agent(&self, agent_id: &str, happened: Happened) {
        if let Some(named) = self.names.get(agent_id) {
            self.harness
                .note_agent(&named.project, happened.kind(), agent_id);
        }
    }
}
