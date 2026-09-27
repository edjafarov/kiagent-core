import React from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Spark } from '@shared/web-ui/Spark';
import './GateLayout.css';

/**
 * The signed-out gate's page: a deep-violet brand panel (the framed mark on
 * a white tile, the tagline at the bottom) beside a centred form column.
 * Every sign-in screen — core's name + email, a product's OAuth — composes
 * this and owns only its form. The brand panel is decoration (aria-hidden);
 * the form carries its own heading.
 */
export function GateLayout(props: {
  tagline: React.ReactNode;
  blurb: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="gate">
      <div className="gate-brand" aria-hidden="true">
        <span className="gate-mark">
          <Spark size="app" />
        </span>
        <div className="gate-copy">
          <div className="gate-tagline">{props.tagline}</div>
          <div className="gate-blurb">{props.blurb}</div>
        </div>
      </div>
      <div className="gate-main">
        <div className="gate-col">
          {props.children}
          <div className="gate-foot">
            <Icon name="shield" size={12} />
            <span>No telemetry · your data stays local</span>
          </div>
        </div>
      </div>
    </div>
  );
}
