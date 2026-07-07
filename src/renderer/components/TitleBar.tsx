import React from 'react';

const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** 30px `titleBarStyle:hidden` overlay strip — see ui-inventory.md §1.6.
 *  No custom traffic lights: the OS chrome draws those, this is purely a
 *  colored strip + centered title sitting above the window content. */
export function TitleBar(): React.ReactElement {
  return (
    <div
      className="kg-titlebar"
      style={
        {
          paddingLeft: isMac ? 76 : 12,
          paddingRight: isMac ? 12 : 140,
        } as React.CSSProperties
      }
    >
      <span className="kg-titlebar-title">KIAgent</span>
    </div>
  );
}
