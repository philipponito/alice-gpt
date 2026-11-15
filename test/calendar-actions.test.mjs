import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCalendarAction } from '../lib/calendar-actions.mjs';

const event = {id:'abc123',etag:'"version"',summary:'Встреча',start:{dateTime:'2026-11-16T11:00:00+03:00'},end:{dateTime:'2026-11-16T12:00:00+03:00'},organizer:{self:true},attendees:[{email:'test@example.invalid'}]};
test('action includes only events actually found and preserves version and guests',()=>{
  const a=prepareCalendarAction('delete',['abc123'],'',[event]);
  assert.equal(a.events[0].etag,'"version"'); assert.equal(a.events[0].hasGuests,true);
  assert.throws(()=>prepareCalendarAction('delete',['unseen'],'',[event]));
});
test('rejects duplicates, unsupported recurring and unowned events',()=>{
  assert.throws(()=>prepareCalendarAction('delete',['abc123','abc123'],'',[event]));
  assert.throws(()=>prepareCalendarAction('delete',['abc123'],'',[{...event,recurringEventId:'series'}]));
  assert.throws(()=>prepareCalendarAction('delete',['abc123'],'',[{...event,organizer:{self:false}}]));
});
test('moving requires one event and an explicit future time',()=>{
  const date=new Date(Date.now()+86400000).toISOString();
  assert.equal(prepareCalendarAction('move',['abc123'],date,[event]).when,date);
  assert.throws(()=>prepareCalendarAction('move',['abc123'],'tomorrow',[event]));
});
