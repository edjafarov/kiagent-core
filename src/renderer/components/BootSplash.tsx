import React from 'react';
import { Spark } from '@shared/web-ui/Spark';
import './BootSplash.css';

/* Branded boot screen shown while the app shell waits for the first
   AppState push. The Spark uses the blink (dim-pulse) state — the one
   motion the brand system allows — so the screen reads as alive without a
   spinner. */
export function BootSplash(): React.ReactElement {
  return (
    <div className="kg-boot-splash" role="status" aria-label="Loading KIAgent">
      <Spark size="app" state="blink" />
      <div className="kg-boot-splash__name" aria-hidden="true">
        KIAgent
      </div>
    </div>
  );
}
