import { describe, expect, it } from 'vitest';
import { escapeCsvField, toCsv } from './csv.util';

describe('escapeCsvField', () => {
  it('leaves a plain field with no special characters unchanged', () => {
    expect(escapeCsvField('Jane Doe')).toBe('Jane Doe');
  });

  it('leaves an empty string unchanged', () => {
    expect(escapeCsvField('')).toBe('');
  });

  it('quotes a field containing a comma', () => {
    expect(escapeCsvField('Doe, Jane')).toBe('"Doe, Jane"');
  });

  it('quotes a field containing a double quote, and doubles the internal quote', () => {
    expect(escapeCsvField('She said "hi"')).toBe('"She said ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes a field containing a carriage return', () => {
    expect(escapeCsvField('line one\rline two')).toBe('"line one\rline two"');
  });

  it('handles a field with commas, quotes, and newlines all at once', () => {
    expect(escapeCsvField('a, "b"\nc')).toBe('"a, ""b""\nc"');
  });
});

describe('toCsv', () => {
  it('joins headers and rows with commas and CRLF line endings', () => {
    const csv = toCsv(['Name', 'Email'], [['Jane Doe', 'jane@example.test']]);
    expect(csv).toBe('Name,Email\r\nJane Doe,jane@example.test\r\n');
  });

  it('escapes every field independently, not just the whole row', () => {
    const csv = toCsv(['Name', 'Notes'], [['Doe, Jane', 'Said "hello"']]);
    expect(csv).toBe('Name,Notes\r\n"Doe, Jane","Said ""hello"""\r\n');
  });

  it('renders an empty row set as just the header line', () => {
    const csv = toCsv(['Name', 'Email'], []);
    expect(csv).toBe('Name,Email\r\n');
  });

  it('renders multiple rows in the given order', () => {
    const csv = toCsv(['Name'], [['A'], ['B'], ['C']]);
    expect(csv).toBe('Name\r\nA\r\nB\r\nC\r\n');
  });
});
