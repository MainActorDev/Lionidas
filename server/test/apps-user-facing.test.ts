import { describe, expect, it } from 'vitest';
import { isUserFacing } from '../src/manual/apps.ts';

/** Run-app modal filter: wallpaper/poster engines, accessibility daemons and
 *  system plumbing are NOT user-facing; user apps and real system apps are. */

describe('isUserFacing', () => {
  it('user apps are always user-facing (no plist read)', () => {
    expect(isUserFacing('com.lionparcel.services.consumer', '/does/not/matter')).toBe(true);
    expect(isUserFacing('com.vendor.sometool.runner', undefined)).toBe(true);
  });

  it('poster/wallpaper engines are not user-facing', () => {
    expect(isUserFacing('com.apple.Posters.KaleidoscopePosterApp')).toBe(false);
    expect(isUserFacing('com.apple.Posters.UnityPosterApp')).toBe(false);
    expect(isUserFacing('com.apple.Posters.WeatherPosterApp')).toBe(false);
    expect(isUserFacing('com.apple.EmojiPoster')).toBe(false);
    expect(isUserFacing('com.apple.GradientPoster')).toBe(false);
    expect(isUserFacing('com.apple.PridePoster')).toBe(false);
    expect(isUserFacing('com.apple.NanoUniverse.AegirProxyApp')).toBe(false);
  });

  it('accessibility daemons and system plumbing are not user-facing', () => {
    for (const id of [
      'com.apple.assistivetouchd', 'com.apple.fullkeyboardaccess', 'com.apple.commandandcontrol',
      'com.apple.VoiceOverTouch', 'com.apple.livetranscriptionui', 'com.apple.EscrowSecurityAlert',
      'com.apple.SystemIntents', 'com.apple.ShortcutsActions', 'com.apple.CarPlayApp',
      'com.apple.Bridge', 'com.apple.webapp', 'com.apple.PreviewShell', 'com.apple.springboard',
    ]) expect(isUserFacing(id)).toBe(false);
  });

  it('real system apps stay user-facing', () => {
    for (const id of [
      'com.apple.mobilesafari', 'com.apple.Preferences', 'com.apple.MobileSMS', 'com.apple.Maps',
      'com.apple.mobileslideshow', 'com.apple.mobilecal', 'com.apple.MobileAddressBook',
      'com.apple.DocumentsApp', 'com.apple.Fitness', 'com.apple.Health', 'com.apple.news',
      'com.apple.Passwords', 'com.apple.Preview', 'com.apple.reminders', 'com.apple.shortcuts',
      'com.apple.Passbook',
    ]) expect(isUserFacing(id)).toBe(true);
  });

  it('unknown com.apple bundle without a readable plist defaults to user-facing', () => {
    expect(isUserFacing('com.apple.SomeNewThing', undefined)).toBe(true);
  });
});
