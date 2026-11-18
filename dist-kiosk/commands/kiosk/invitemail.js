"use strict";
/**
 * The invitation email: one QR code that opens the relay's invitation page, put into an Apple Mail
 * draft for the owner to review and send. Nothing here sends mail. The QR code is drawn by python3
 * with segno, which is on the owner's Mac; the invitee never needs it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.qrPng = qrPng;
exports.qrTerminal = qrTerminal;
exports.mailDraft = mailDraft;
const child_process_1 = require("child_process");
const PY = `
import sys, segno
qr = segno.make(sys.argv[1], error='m')
if sys.argv[2] == '-':
    qr.terminal(compact=True)
else:
    qr.save(sys.argv[2], scale=12, border=4, dark='#000000', light='#ffffff')
`;
const python = () => process.env.KIOSK_PYTHON || 'python3';
function qrPng(url, out) {
    const r = (0, child_process_1.spawnSync)(python(), ['-c', PY, url, out], { encoding: 'utf8' });
    if (r.status !== 0)
        throw new Error(`Could not draw the QR code; python3 with segno is needed (${(r.stderr || '').trim().split('\n').pop()}).`);
}
function qrTerminal(url) {
    const r = (0, child_process_1.spawnSync)(python(), ['-c', PY, url, '-'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
}
const OSA = `on run argv
  set theTo to item 1 of argv
  set theSubject to item 2 of argv
  set theBody to item 3 of argv
  set theFile to POSIX file (item 4 of argv)
  set theFrom to item 5 of argv
  tell application "Mail"
    if theFrom is not "" then
      set m to make new outgoing message with properties {sender:theFrom, subject:theSubject, content:theBody & return & return, visible:true}
    else
      set m to make new outgoing message with properties {subject:theSubject, content:theBody & return & return, visible:true}
    end if
    tell m
      make new to recipient at end of to recipients with properties {address:theTo}
      tell content
        make new attachment with properties {file name:theFile} at after the last paragraph
      end tell
    end tell
    activate
  end tell
end run`;
/** Opens a compose window in Apple Mail with the QR code attached. The owner reviews and sends it.
 * The sender is set when the message is made: Mail ignores a sender set afterwards and uses its default account. */
function mailDraft(o) {
    const r = (0, child_process_1.spawnSync)('osascript', ['-e', OSA, o.to, o.subject, o.body, o.attachment, o.from || ''], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0)
        throw new Error(`Apple Mail could not open the draft: ${(r.stderr || '').trim()}`);
}
