import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function AppShell() {
  useEffect(() => {
    let cancelled = false;
    import('./app.js').catch((error) => {
      if (cancelled) return;
      const view = document.querySelector('#view');
      if (view) view.textContent = error instanceof Error ? error.message : String(error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <div className="app">
        <button className="iconbtn drawertoggle" id="navToggle" aria-label="Open menu">Menu</button>
        <button className="iconbtn drawertoggle" id="chatToggle" aria-label="Open assistant">Chat</button>

        <aside id="sidebar" aria-label="Navigation" />

        <main>
          <div id="view" />
        </main>

        <section className="chat" aria-label="Assistant">
          <div className="head">
            <button className="iconbtn" id="threadsBtn" title="Conversations" aria-label="Conversations">History</button>
            <span className="threadtitle" id="threadTitle">New chat</span>
            <button className="iconbtn" id="newThreadBtn" title="New conversation" aria-label="New conversation">New</button>
          </div>
          <div className="threadmenu" id="threadMenu" hidden />
          <div className="msgs" id="msgs" />
          <div className="suggest" id="suggest" />
          <div className="compose">
            <div className="contextbar" id="contextBar" />
            <div className="contextattachments" id="contextAttachments" />
            <div className="composebox">
              <textarea id="input" rows="2" placeholder="Ask about the current ledger..." />
              <button className="sendbtn" id="sendBtn" aria-label="Send">Send</button>
            </div>
          </div>
        </section>

        <div className="scrim" id="scrim" />
      </div>
      <div id="modalRoot" />
      <div id="toast" role="status" aria-live="polite" />
    </>
  );
}

createRoot(document.getElementById('root')).render(<AppShell />);
