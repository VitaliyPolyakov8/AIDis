import { memo } from 'react';
import { findInviteCodes } from '../guilds/inviteLinks';
import { InvitePreviewCard, useInvitePreview } from '../guilds/InvitePreviewCard';

/** Cards stay small: at most this many per message. */
const MAX_CARDS = 3;

function OneInvite({ code }: { code: string }) {
  const preview = useInvitePreview(code);
  return <InvitePreviewCard state={preview} compact />;
}

/** 0.7.0: invite links in a message show the server with a Join / Open button. */
export const InviteCards = memo(function InviteCards({ content }: { content: string }) {
  if (!content.includes('/invite/')) return null;
  const codes = findInviteCodes(content).slice(0, MAX_CARDS);
  if (codes.length === 0) return null;
  return (
    <div className="invite-cards">
      {codes.map((code) => (
        <OneInvite key={code} code={code} />
      ))}
    </div>
  );
});
