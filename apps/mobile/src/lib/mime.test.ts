import { describe, expect, it } from 'vitest';
import { mimeFor } from './mime';

describe('mimeFor', () => {
  it('maps common media by extension, case-insensitively', () => {
    expect(mimeFor('WIN_20250405_14_45_23_Pro.MP4')).toBe('video/mp4');
    expect(mimeFor('a.jpeg')).toBe('image/jpeg');
    expect(mimeFor('a.m4a')).toBe('audio/mp4');
    expect(mimeFor('budget.XLSX')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(mimeFor('report.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(mimeFor('slides.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(mimeFor('archive.zip')).toBe('application/zip');
    expect(mimeFor('release.apk')).toBe('application/vnd.android.package-archive');
  });
  it('prefers a real declared type but not the generic one', () => {
    expect(mimeFor('a.mp4', 'video/quicktime')).toBe('video/quicktime');
    expect(mimeFor('a.mp4', 'application/octet-stream')).toBe('video/mp4');
  });
  it('returns an empty string for unknown files', () => {
    expect(mimeFor('notes')).toBe('');
  });
});
