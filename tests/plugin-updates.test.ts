import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmUpdateTarget } from '../shared/dashboard/plugin-updates.ts'

test('a market install pinned to its exact version still sees newer releases', () => {
  // Installed 1.0.0 from the market: the saved range is "1.0.0", so it alone matches nothing newer.
  assert.equal(npmUpdateTarget({ updates: [{ version: '1.1.0' }], latestVersion: '1.1.0', latestMatchingVersion: '1.0.0' }, '1.0.0'), '1.1.0')
})

test('the newest version within the saved range comes first', () => {
  assert.equal(npmUpdateTarget({ updates: [{ version: '1.2.0' }, { version: '2.0.0' }], latestVersion: '2.0.0', latestMatchingVersion: '1.2.0' }, '1.1.0'), '1.2.0')
})

test('nothing is offered when the installed version is the newest, or newer than latest', () => {
  assert.equal(npmUpdateTarget({ updates: [], latestVersion: '1.1.0', latestMatchingVersion: '1.1.0' }, '1.1.0'), undefined)
  assert.equal(npmUpdateTarget({ updates: [], latestVersion: '1.0.0', latestMatchingVersion: '1.0.0' }, '1.1.0-beta.1'), undefined, 'never a downgrade')
  assert.equal(npmUpdateTarget({}, '1.0.0'), undefined)
})
