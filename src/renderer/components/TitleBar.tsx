import React from 'react';
import { detectPlatform } from '@shared/web-ui/ui';
import { useProductName } from '@renderer/state/product-name';

/** Drag band shown only on the signed-out gates (BootSplash, SignIn). The
 *  signed-in shell draws the same 48px white band from its sidebar head and
 *  page top bar. Leaves room for the traffic lights (macOS) or the caption
 *  buttons (Windows/Linux). */
export function TitleBar(): React.ReactElement {
  const product = useProductName();
  return (
    <div className={`ui-titlebar is-${detectPlatform()}`}>
      <span>{product}</span>
    </div>
  );
}
