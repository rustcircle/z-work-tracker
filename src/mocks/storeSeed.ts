// E2E-only seeds for the Microsoft Store screenshots: `?seed=store-web`, `?seed=store-swe` and `?seed=store-data`. Each is one
// person's store at Friday 6 November 2026, 16:40 UTC, with five weeks of work behind it, so the screens the listing shows are
// full of plausible things and name nobody real. They are used by e2e/store-shots.spec.ts and the tests in storeSeed.test.ts, and
// reach no user's store: only the e2e entry imports them.
//
//   store-web   A freelance web developer in Lisbon, billing three clients by the hour or by the fee, with a client in New York.
//               The running task, Checkout flow, has four subtasks, three with tags of their own: the tags button and its list.
//   store-swe   A contractor in Berlin working with a team in Los Angeles, mostly in the evening overlap; dark theme.
//   store-data  A data scientist in Amsterdam with a client in London, billing in euros; the running task, Churn model v2, has
//               five subtasks that count under different tags.
//
// Every day is a list of blocks, `[task, 'HH:MM-HH:MM', subtask?]` in the person's own zone; a span with no end, `'15:00-'`, is the
// segment still running. The weeks before this one repeat a pattern with each block moved by up to 10 minutes, the same every
// time, so the days do not look cut from one template. This week is written out, day by day. The Billing summaries that
// "were issued" earlier are made with the mock's own `create_summary` at the time they were issued.
import { addDays, instantOfWall, parseIso, toIso, weekdayOf } from '../lib/tz';
import type { Currency, Theme } from '../lib/types';
import { subtaskDoc } from './demoSeed';
import { DEVICE_ID, emptyState, handle, type MockProject, type MockSegment, type MockState, type MockTask } from './ipcMock';

export const STORE_SEEDS = ['store-web', 'store-swe', 'store-data'] as const;
export type StoreSeed = (typeof STORE_SEEDS)[number];
export const isStoreSeed = (value: string | null): value is StoreSeed => STORE_SEEDS.some((seed) => seed === value);

/** The moment the three stores stand at: a Friday afternoon, with the week's target nearly met. The page clock is set to it too. */
export const STORE_NOW = '2026-11-06T16:40:00Z';

/** `[task, 'HH:MM-HH:MM', subtask?]`: a stretch of work on a task, on one of its subtasks if named. `'HH:MM-'` has no end yet. */
type Block = readonly [task: string, span: string, subtask?: string];
type Day = readonly Block[];
/** Monday to Friday. */
type Week = readonly [Day, Day, Day, Day, Day];

interface ProjectDef {
  id: string;
  name: string;
  color: string;
  billable?: false;
  budgetHours?: number;
  clientZone?: string;
  /** Price per hour in cents. A fixed-fee project keeps one too, to value its time against the fee. */
  rate?: readonly [cents: number, currency: Currency];
  fee?: readonly [cents: number, currency: Currency];
}

interface ItemDef {
  id: string;
  text: string;
  checked?: boolean;
  /** Its own tags. Left out, the item follows its task ("Same as task"); `[]` is "No tag". */
  tags?: readonly string[];
}

interface TaskDef {
  id: string;
  name: string;
  project: string;
  state: 'running' | 'paused' | 'stopped' | 'draft';
  tags: readonly string[];
  items?: readonly ItemDef[];
  /** The subtask new time goes to. */
  active?: string;
}

interface ShiftDef {
  id: string;
  name: string;
  color: string;
  start: string;
  end: string;
  zone: string;
}

interface SummaryDef {
  project: string;
  from: string;
  to: string;
  /** The day it was issued, at the end of the working day. */
  on: string;
}

interface Persona {
  theme: Theme;
  zone: string;
  client: { zone: string; from: string; to: string };
  targets: { daily: number; weekly: number };
  tags: readonly (readonly [id: string, name: string, color: string])[];
  projects: readonly ProjectDef[];
  shifts: readonly ShiftDef[];
  tasks: readonly TaskDef[];
  /** Used in turn for the weeks before this one, from 5 October on. */
  weeks: readonly Week[];
  /** This week, which ends today with the running segment. */
  thisWeek: Week;
  summaries: readonly SummaryDef[];
}

const FIRST_MONDAY = '2026-10-05';
const THIS_MONDAY = '2026-11-02';
const LONG_AGO = '2026-09-01T00:00:00Z';

// ------------------------------------------------------------------------------------------------ the web developer

const WEB: Persona = {
  theme: 'light',
  zone: 'Europe/Lisbon',
  client: { zone: 'America/New_York', from: '09:00', to: '17:00' },
  targets: { daily: 6, weekly: 32 },
  tags: [
    ['tag-frontend', 'Frontend', '#4f46e5'],
    ['tag-backend', 'Backend', '#0f766e'],
    ['tag-design', 'Design', '#db2777'],
    ['tag-meeting', 'Meeting', '#b45309'],
    ['tag-bugfix', 'Bug fix', '#dc2626'],
  ],
  projects: [
    { id: 'p-northwind', name: 'Online store rebuild', color: '#2563eb', budgetHours: 120, clientZone: 'America/New_York', rate: [9500, 'USD'] },
    { id: 'p-harbor', name: 'Coffee shop website', color: '#059669', budgetHours: 60, clientZone: 'America/New_York', rate: [8000, 'USD'] },
    { id: 'p-maple', name: 'Clinic landing page', color: '#d97706', clientZone: 'America/New_York', fee: [240_000, 'USD'], rate: [7500, 'USD'] },
    { id: 'p-admin', name: 'Admin and learning', color: '#64748b', billable: false },
  ],
  shifts: [
    { id: 'deep', name: 'Deep work', color: '#0891b2', start: '09:00', end: '13:00', zone: 'Europe/Lisbon' },
    { id: 'us', name: 'US overlap', color: '#7c3aed', start: '09:00', end: '13:00', zone: 'America/New_York' },
  ],
  tasks: [
    {
      id: 't-checkout',
      name: 'Checkout flow',
      project: 'p-northwind',
      state: 'running',
      tags: ['tag-frontend', 'tag-backend', 'tag-design'],
      active: 'st-pay',
      items: [
        { id: 'st-cart', text: 'Cart page', checked: true, tags: ['tag-frontend', 'tag-design'] },
        { id: 'st-pay', text: 'Payment API', tags: ['tag-backend'] },
        { id: 'st-mail', text: 'Order confirmation email' },
        { id: 'st-notes', text: 'Release notes', tags: [] },
      ],
    },
    {
      id: 't-menu',
      name: 'Menu and ordering form',
      project: 'p-harbor',
      state: 'paused',
      tags: ['tag-frontend', 'tag-design'],
      active: 'st-order',
      items: [
        { id: 'st-menu', text: 'Menu layout', checked: true, tags: ['tag-design'] },
        { id: 'st-order', text: 'Order form', tags: ['tag-frontend'] },
        { id: 'st-valid', text: 'Validation and errors' },
      ],
    },
    { id: 't-next', name: 'Dark mode for the dashboard', project: 'p-northwind', state: 'draft', tags: ['tag-frontend', 'tag-design'] },
    { id: 't-search', name: 'Product search and filters', project: 'p-northwind', state: 'stopped', tags: ['tag-frontend'] },
    { id: 't-mobile', name: 'Mobile layout fixes', project: 'p-northwind', state: 'stopped', tags: ['tag-bugfix', 'tag-frontend'] },
    { id: 't-nwcall', name: 'Weekly client call', project: 'p-northwind', state: 'stopped', tags: ['tag-meeting'] },
    { id: 't-hero', name: 'Hero section redesign', project: 'p-harbor', state: 'stopped', tags: ['tag-design'] },
    { id: 't-perf', name: 'Performance and SEO', project: 'p-harbor', state: 'stopped', tags: ['tag-backend'] },
    { id: 't-landing', name: 'Landing page build', project: 'p-maple', state: 'stopped', tags: ['tag-frontend', 'tag-design'] },
    { id: 't-forms', name: 'Booking form and emails', project: 'p-maple', state: 'stopped', tags: ['tag-backend'] },
    { id: 't-invoices', name: 'Invoices and admin', project: 'p-admin', state: 'stopped', tags: [] },
    { id: 't-learn', name: 'Learning: server components', project: 'p-admin', state: 'stopped', tags: [] },
  ],
  weeks: [
    [
      [['t-search', '09:05-10:45'], ['t-search', '11:05-12:40'], ['t-invoices', '14:00-14:35'], ['t-menu', '15:00-16:45', 'st-order'], ['t-menu', '17:10-18:00', 'st-valid']],
      [['t-hero', '09:00-10:40'], ['t-hero', '11:05-12:30'], ['t-nwcall', '14:00-14:45'], ['t-checkout', '15:10-16:50', 'st-cart'], ['t-checkout', '17:15-18:05', 'st-cart']],
      [['t-landing', '09:10-10:55'], ['t-landing', '11:20-12:50'], ['t-forms', '14:00-15:35'], ['t-checkout', '16:00-17:45', 'st-pay']],
      [['t-mobile', '09:00-10:30'], ['t-perf', '10:55-12:35'], ['t-checkout', '14:05-15:40', 'st-mail'], ['t-checkout', '16:05-17:35', 'st-pay']],
      [['t-menu', '09:00-10:35', 'st-menu'], ['t-hero', '11:00-12:20'], ['t-invoices', '14:00-14:45'], ['t-landing', '15:10-16:50']],
    ],
    [
      [['t-checkout', '09:00-10:40', 'st-cart'], ['t-checkout', '11:05-12:30', 'st-cart'], ['t-forms', '14:00-15:30'], ['t-search', '15:55-17:40']],
      [['t-landing', '09:05-10:50'], ['t-menu', '11:15-12:45', 'st-order'], ['t-nwcall', '14:00-14:40'], ['t-menu', '15:05-16:45', 'st-valid'], ['t-invoices', '17:10-17:45']],
      [['t-hero', '09:00-10:35'], ['t-hero', '11:00-12:25'], ['t-checkout', '14:05-15:45', 'st-pay'], ['t-checkout', '16:10-17:50', 'st-pay']],
      [['t-perf', '09:10-10:50'], ['t-mobile', '11:15-12:40'], ['t-search', '14:00-15:40'], ['t-checkout', '16:05-17:30', 'st-mail']],
      [['t-checkout', '09:00-10:45', 'st-cart'], ['t-landing', '11:10-12:35'], ['t-learn', '14:00-15:10'], ['t-menu', '15:35-17:00', 'st-menu']],
    ],
  ],
  thisWeek: [
    [['t-search', '09:05-10:45'], ['t-search', '11:05-12:40'], ['t-invoices', '14:00-14:35'], ['t-checkout', '15:00-16:45', 'st-cart'], ['t-checkout', '17:10-18:00', 'st-cart']],
    [['t-hero', '09:00-10:40'], ['t-hero', '11:05-12:30'], ['t-nwcall', '14:00-14:45'], ['t-checkout', '15:10-16:50', 'st-cart'], ['t-checkout', '17:15-18:05', 'st-pay']],
    [['t-landing', '09:10-10:55'], ['t-landing', '11:20-12:50'], ['t-forms', '14:00-15:35'], ['t-checkout', '16:00-17:45', 'st-pay']],
    [['t-mobile', '09:00-10:30'], ['t-perf', '10:55-12:35'], ['t-checkout', '14:05-15:40', 'st-mail'], ['t-checkout', '16:05-17:35', 'st-pay']],
    [['t-menu', '09:00-10:35', 'st-menu'], ['t-checkout', '10:55-12:30', 'st-cart'], ['t-invoices', '14:00-14:40'], ['t-checkout', '15:00-', 'st-pay']],
  ],
  summaries: [
    { project: 'p-northwind', from: '2026-10-05', to: '2026-10-16', on: '2026-10-16' },
    { project: 'p-harbor', from: '2026-10-05', to: '2026-10-23', on: '2026-10-23' },
    { project: 'p-northwind', from: '2026-10-19', to: '2026-10-30', on: '2026-10-30' },
  ],
};

// ------------------------------------------------------------------------------------------------ the software engineer

const SWE: Persona = {
  theme: 'dark',
  zone: 'Europe/Berlin',
  client: { zone: 'America/Los_Angeles', from: '09:00', to: '17:00' },
  targets: { daily: 7, weekly: 35 },
  tags: [
    ['tag-feature', 'Feature', '#2563eb'],
    ['tag-bug', 'Bug', '#dc2626'],
    ['tag-review', 'Review', '#7c3aed'],
    ['tag-ops', 'Ops', '#0d9488'],
    ['tag-meetings', 'Meetings', '#d97706'],
  ],
  projects: [
    { id: 'p-ledger', name: 'Payments API', color: '#4f46e5', budgetHours: 100, clientZone: 'America/Los_Angeles', rate: [11_000, 'USD'] },
    { id: 'p-mobile', name: 'Mobile app v3', color: '#0891b2', budgetHours: 120, clientZone: 'America/Los_Angeles', rate: [10_500, 'USD'] },
    { id: 'p-infra', name: 'Infra and on-call', color: '#65a30d', budgetHours: 60, clientZone: 'America/Los_Angeles', rate: [10_000, 'USD'] },
    { id: 'p-audit', name: 'Security audit', color: '#ea580c', clientZone: 'America/Los_Angeles', fee: [280_000, 'USD'], rate: [10_000, 'USD'] },
    { id: 'p-oss', name: 'Open source', color: '#64748b', billable: false },
  ],
  shifts: [
    { id: 'focus', name: 'Focus', color: '#0e7490', start: '11:00', end: '15:00', zone: 'Europe/Berlin' },
    { id: 'overlap', name: 'SF overlap', color: '#a21caf', start: '09:00', end: '12:00', zone: 'America/Los_Angeles' },
  ],
  tasks: [
    {
      id: 't-webhooks',
      name: 'Webhook retries',
      project: 'p-ledger',
      state: 'running',
      tags: ['tag-feature', 'tag-bug', 'tag-ops'],
      active: 'st-dlq',
      items: [
        { id: 'st-backoff', text: 'Backoff policy', checked: true, tags: ['tag-feature'] },
        { id: 'st-dlq', text: 'Dead-letter queue', tags: ['tag-feature', 'tag-ops'] },
        { id: 'st-dupes', text: 'Fix duplicate deliveries', tags: ['tag-bug'] },
        { id: 'st-runbook', text: 'Update the runbook' },
      ],
    },
    { id: 't-export', name: 'CSV export endpoint', project: 'p-ledger', state: 'paused', tags: ['tag-feature'] },
    { id: 't-limiter', name: 'Rate limiter design doc', project: 'p-ledger', state: 'draft', tags: ['tag-feature', 'tag-review'] },
    { id: 't-reviews', name: 'Code reviews', project: 'p-ledger', state: 'stopped', tags: ['tag-review'] },
    { id: 't-planning', name: 'Standup and sprint planning', project: 'p-ledger', state: 'stopped', tags: ['tag-meetings'] },
    { id: 't-pg', name: 'Upgrade Postgres to 16', project: 'p-infra', state: 'stopped', tags: ['tag-ops', 'tag-feature'] },
    { id: 't-ci', name: 'Fix flaky CI', project: 'p-infra', state: 'stopped', tags: ['tag-bug', 'tag-ops'] },
    { id: 't-oncall', name: 'On-call: incident 214', project: 'p-infra', state: 'stopped', tags: ['tag-ops', 'tag-bug'] },
    { id: 't-sdk', name: 'Swift SDK: auth flow', project: 'p-mobile', state: 'stopped', tags: ['tag-feature'] },
    { id: 't-crash', name: 'Crash on cold start', project: 'p-mobile', state: 'stopped', tags: ['tag-bug'] },
    { id: 't-threat', name: 'Threat model review', project: 'p-audit', state: 'stopped', tags: ['tag-review', 'tag-ops'] },
    { id: 't-pentest', name: 'Fix pentest findings', project: 'p-audit', state: 'stopped', tags: ['tag-bug', 'tag-review'] },
    { id: 't-parser', name: 'Parser library pull request', project: 'p-oss', state: 'stopped', tags: [] },
  ],
  weeks: [
    [
      [['t-planning', '11:00-11:30'], ['t-webhooks', '11:50-13:15', 'st-backoff'], ['t-webhooks', '14:30-16:10', 'st-backoff'], ['t-reviews', '16:35-17:30'], ['t-planning', '18:00-18:30'], ['t-sdk', '18:50-20:50']],
      [['t-webhooks', '11:00-12:50', 'st-dlq'], ['t-pg', '14:00-15:45'], ['t-reviews', '16:10-17:00'], ['t-planning', '18:00-18:30'], ['t-crash', '18:50-20:30']],
      [['t-export', '11:00-12:45'], ['t-export', '14:15-15:55'], ['t-threat', '16:25-17:40'], ['t-planning', '18:00-18:30'], ['t-sdk', '18:55-20:25']],
      [['t-webhooks', '11:00-12:40', 'st-dupes'], ['t-ci', '14:00-15:30'], ['t-threat', '15:55-17:25'], ['t-planning', '18:00-18:30'], ['t-pentest', '18:55-20:40']],
      [['t-oncall', '11:00-12:30'], ['t-pg', '13:00-14:20'], ['t-reviews', '14:50-15:50'], ['t-parser', '16:15-17:30']],
    ],
    [
      [['t-planning', '11:00-11:30'], ['t-export', '11:50-13:20'], ['t-export', '14:30-16:00'], ['t-reviews', '16:30-17:30'], ['t-planning', '18:00-18:30'], ['t-crash', '18:55-20:45']],
      [['t-ci', '11:00-12:40'], ['t-webhooks', '14:00-15:50', 'st-backoff'], ['t-threat', '16:15-17:20'], ['t-planning', '18:00-18:30'], ['t-sdk', '18:50-20:35']],
      [['t-pg', '11:00-12:50'], ['t-pg', '14:10-15:40'], ['t-reviews', '16:05-17:05'], ['t-planning', '18:00-18:30'], ['t-pentest', '18:55-20:30']],
      [['t-webhooks', '11:05-12:45', 'st-dlq'], ['t-oncall', '14:00-15:20'], ['t-threat', '15:45-17:25'], ['t-planning', '18:00-18:30'], ['t-export', '18:50-20:20']],
      [['t-webhooks', '11:00-12:35', 'st-dupes'], ['t-reviews', '13:05-14:15'], ['t-parser', '14:40-16:10']],
    ],
  ],
  thisWeek: [
    [['t-planning', '11:00-11:30'], ['t-webhooks', '11:50-13:15', 'st-backoff'], ['t-webhooks', '14:30-16:10', 'st-backoff'], ['t-reviews', '16:35-17:30'], ['t-planning', '18:00-18:30'], ['t-sdk', '18:50-20:50']],
    [['t-webhooks', '11:00-12:50', 'st-dlq'], ['t-pg', '14:00-15:45'], ['t-reviews', '16:10-17:00'], ['t-planning', '18:00-18:30'], ['t-crash', '18:50-20:30']],
    [['t-export', '11:00-12:45'], ['t-export', '14:15-15:55'], ['t-threat', '16:25-17:40'], ['t-planning', '18:00-18:30'], ['t-pentest', '18:55-20:25']],
    [['t-webhooks', '11:00-12:40', 'st-dupes'], ['t-ci', '14:00-15:30'], ['t-threat', '15:55-17:25'], ['t-planning', '18:00-18:30'], ['t-pentest', '18:55-20:40']],
    [['t-oncall', '11:00-12:30'], ['t-webhooks', '13:15-14:40', 'st-backoff'], ['t-reviews', '15:00-15:50'], ['t-webhooks', '16:10-', 'st-dlq']],
  ],
  summaries: [
    { project: 'p-ledger', from: '2026-10-05', to: '2026-10-16', on: '2026-10-16' },
    { project: 'p-infra', from: '2026-10-05', to: '2026-10-30', on: '2026-10-30' },
    { project: 'p-ledger', from: '2026-10-19', to: '2026-10-30', on: '2026-10-30' },
  ],
};

// ------------------------------------------------------------------------------------------------ the data scientist

const DATA: Persona = {
  theme: 'light',
  zone: 'Europe/Amsterdam',
  client: { zone: 'Europe/London', from: '09:00', to: '17:00' },
  targets: { daily: 6, weekly: 32 },
  tags: [
    ['tag-prep', 'Data prep', '#0891b2'],
    ['tag-model', 'Modeling', '#7c3aed'],
    ['tag-eval', 'Evaluation', '#65a30d'],
    ['tag-report', 'Reporting', '#ea580c'],
    ['tag-meet', 'Meetings', '#64748b'],
  ],
  projects: [
    { id: 'p-churn', name: 'Telecom churn model', color: '#2563eb', budgetHours: 150, clientZone: 'Europe/London', rate: [9000, 'EUR'] },
    { id: 'p-forecast', name: 'Demand forecasting', color: '#059669', budgetHours: 100, clientZone: 'Europe/London', rate: [8500, 'EUR'] },
    { id: 'p-dash', name: 'Analytics dashboards', color: '#d97706', clientZone: 'Europe/London', fee: [150_000, 'EUR'], rate: [8000, 'EUR'] },
    { id: 'p-reading', name: 'Reading and research', color: '#db2777', billable: false },
  ],
  shifts: [
    { id: 'morning', name: 'Morning', color: '#0891b2', start: '09:00', end: '13:00', zone: 'Europe/Amsterdam' },
    { id: 'afternoon', name: 'Afternoon', color: '#7c3aed', start: '14:00', end: '17:30', zone: 'Europe/Amsterdam' },
  ],
  tasks: [
    {
      id: 't-churn',
      name: 'Churn model v2',
      project: 'p-churn',
      state: 'running',
      tags: ['tag-prep', 'tag-model', 'tag-eval', 'tag-report'],
      active: 'st-write',
      items: [
        { id: 'st-clean', text: 'Clean the customer table', checked: true, tags: ['tag-prep'] },
        { id: 'st-feat', text: 'Feature engineering', checked: true, tags: ['tag-prep', 'tag-model'] },
        { id: 'st-train', text: 'Train gradient boosting', checked: true, tags: ['tag-model'] },
        { id: 'st-eval', text: 'Evaluate on the holdout', tags: ['tag-eval'] },
        { id: 'st-write', text: 'Write-up for the client', tags: ['tag-report'] },
      ],
    },
    { id: 't-hyper', name: 'Hyperparameter search', project: 'p-churn', state: 'paused', tags: ['tag-model'] },
    { id: 't-card', name: 'Model card and handover', project: 'p-churn', state: 'draft', tags: ['tag-report'] },
    { id: 't-eda', name: 'Exploratory analysis', project: 'p-churn', state: 'stopped', tags: ['tag-prep'] },
    { id: 't-sync', name: 'Client sync', project: 'p-churn', state: 'stopped', tags: ['tag-meet'] },
    { id: 't-forecast', name: 'Weekly sales forecast', project: 'p-forecast', state: 'stopped', tags: ['tag-model', 'tag-eval'] },
    { id: 't-pipe', name: 'Data pipeline refactor', project: 'p-forecast', state: 'stopped', tags: ['tag-prep'] },
    { id: 't-dash', name: 'Executive dashboard', project: 'p-dash', state: 'stopped', tags: ['tag-report'] },
    { id: 't-papers', name: 'Paper reading: uplift models', project: 'p-reading', state: 'stopped', tags: [] },
  ],
  weeks: [
    [
      [['t-churn', '09:00-10:40', 'st-clean'], ['t-churn', '11:00-12:30', 'st-clean'], ['t-sync', '14:00-14:45'], ['t-churn', '15:10-17:20', 'st-feat']],
      [['t-churn', '09:05-10:50', 'st-feat'], ['t-churn', '11:15-12:45', 'st-feat'], ['t-forecast', '14:00-15:40'], ['t-pipe', '16:05-17:35']],
      [['t-churn', '09:00-10:45', 'st-train'], ['t-hyper', '11:10-12:40'], ['t-papers', '14:00-14:50'], ['t-churn', '15:15-17:10', 'st-train']],
      [['t-dash', '09:00-10:40'], ['t-dash', '11:05-12:30'], ['t-churn', '14:00-15:35', 'st-eval'], ['t-churn', '16:00-17:20', 'st-eval']],
      [['t-forecast', '09:00-10:45'], ['t-pipe', '11:10-12:30'], ['t-churn', '14:00-15:40', 'st-write']],
    ],
    [
      [['t-eda', '09:00-10:35'], ['t-eda', '11:00-12:30'], ['t-sync', '14:00-14:40'], ['t-churn', '15:05-17:15', 'st-clean']],
      [['t-forecast', '09:10-10:50'], ['t-pipe', '11:15-12:40'], ['t-churn', '14:00-15:45', 'st-feat'], ['t-churn', '16:10-17:30', 'st-feat']],
      [['t-churn', '09:00-10:40', 'st-train'], ['t-churn', '11:05-12:35', 'st-train'], ['t-hyper', '14:00-15:30'], ['t-papers', '15:55-17:00']],
      [['t-dash', '09:05-10:45'], ['t-dash', '11:10-12:30'], ['t-forecast', '14:00-15:40'], ['t-churn', '16:05-17:25', 'st-eval']],
      [['t-churn', '09:00-10:45', 'st-eval'], ['t-pipe', '11:10-12:30'], ['t-churn', '14:00-15:30', 'st-write']],
    ],
  ],
  thisWeek: [
    [['t-churn', '09:00-10:40', 'st-clean'], ['t-churn', '11:00-12:30', 'st-clean'], ['t-sync', '14:00-14:45'], ['t-churn', '15:10-17:20', 'st-feat']],
    [['t-churn', '09:05-10:50', 'st-feat'], ['t-churn', '11:15-12:45', 'st-feat'], ['t-forecast', '14:00-15:40'], ['t-pipe', '16:05-17:35']],
    [['t-churn', '09:00-10:45', 'st-train'], ['t-hyper', '11:10-12:40'], ['t-papers', '14:00-14:50'], ['t-churn', '15:15-17:10', 'st-train']],
    [['t-dash', '09:00-10:40'], ['t-dash', '11:05-12:30'], ['t-churn', '14:00-15:35', 'st-eval'], ['t-churn', '16:00-17:20', 'st-eval']],
    [['t-forecast', '09:00-10:45'], ['t-pipe', '11:10-12:30'], ['t-churn', '15:10-', 'st-write']],
  ],
  summaries: [
    { project: 'p-churn', from: '2026-10-05', to: '2026-10-16', on: '2026-10-16' },
    { project: 'p-forecast', from: '2026-10-05', to: '2026-10-23', on: '2026-10-23' },
    { project: 'p-dash', from: '2026-10-05', to: '2026-10-30', on: '2026-10-30' },
  ],
};

// ------------------------------------------------------------------------------------------------ building a store

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) throw new Error(`store seed: "${hhmm}" is not HH:MM`);
  return h * 60 + m;
};

/** Where a block starts and ends in the person's zone, in minutes past midnight; `null` for a block still running. */
function spanOf(span: string): [number, number | null] {
  const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})?$/.exec(span);
  if (!m || m[1] === undefined) throw new Error(`store seed: "${span}" is not HH:MM-HH:MM or HH:MM-`);
  return [minutesOf(m[1]), m[2] === undefined ? null : minutesOf(m[2])];
}

/** -10, -5, 0, 5 or 10 minutes: the same for the same week, day and block, so a seed is the same every time. */
function nudge(week: number, day: number, block: number): number {
  const mixed = (((week * 7 + day) * 5 + block) * 2_654_435_761) >>> 0;
  return (mixed % 5) * 5 - 10;
}

interface DayOfWork {
  day: string;
  blocks: Day;
  /** The week's number among the ones moved a little, or null for this week, whose blocks are as written. */
  moved: number | null;
}

/** Every day with work, oldest first: the weeks before this one from their patterns, then this week as written. */
function daysOf(p: Persona): DayOfWork[] {
  const out: DayOfWork[] = [];
  let week = 0;
  for (let monday = FIRST_MONDAY; monday < THIS_MONDAY; monday = addDays(monday, 7)) {
    const pattern = p.weeks[week % p.weeks.length];
    if (!pattern) throw new Error('store seed: a persona needs at least one weekly pattern');
    pattern.forEach((blocks, d) => out.push({ day: addDays(monday, d), blocks, moved: week }));
    week += 1;
  }
  p.thisWeek.forEach((blocks, d) => out.push({ day: addDays(THIS_MONDAY, d), blocks, moved: null }));
  return out;
}

function build(p: Persona): MockState {
  const s = emptyState(STORE_NOW);
  const stamp = { at: LONG_AGO, by: DEVICE_ID };
  s.systemZone = p.zone;
  s.theme = p.theme;
  s.tags = p.tags.map(([id, name, color]) => ({ id, name, color, deleted: false, stamp }));

  for (const d of p.projects) {
    const project: MockProject = {
      id: d.id,
      name: d.name,
      color: d.color,
      archived: false,
      billable: d.billable !== false,
      budgetHours: d.budgetHours ?? null,
      clientZone: d.clientZone ?? null,
      createdAt: LONG_AGO,
      hasTasks: true,
      ...(d.fee ? { billingType: 'fixedFee' as const, fixedFeeCents: d.fee[0], feeCurrency: d.fee[1] } : {}),
    };
    s.projects.push(project);
    if (d.rate) s.rates.push({ id: `r-${d.id}`, projectId: d.id, effectiveFrom: LONG_AGO, rateCents: d.rate[0], currency: d.rate[1], deleted: false, stamp });
  }
  for (const d of p.shifts) {
    s.shifts.push({
      id: `sv-${d.id}`,
      shiftId: `sh-${d.id}`,
      effectiveFrom: '2026-09-01',
      name: d.name,
      color: d.color,
      start: d.start,
      end: d.end,
      weekdays: [1, 2, 3, 4, 5],
      zone: d.zone,
      breakMinutes: 0,
      retired: false,
      deleted: false,
      stamp,
    });
  }

  // Segments, day by day.
  const taskDefs = new Map(p.tasks.map((t) => [t.id, t]));
  let n = 0;
  for (const { day, blocks, moved } of daysOf(p)) {
    blocks.forEach(([taskId, span, subtask], i) => {
      const def = taskDefs.get(taskId);
      if (!def) throw new Error(`store seed: no task ${taskId}`);
      if (subtask !== undefined && !def.items?.some((item) => item.id === subtask)) throw new Error(`store seed: ${taskId} has no subtask ${subtask}`);
      const [from, to] = spanOf(span);
      const by = moved === null ? 0 : nudge(moved, weekdayOf(day), i);
      n += 1;
      const segment: MockSegment = {
        id: `ss${n}`,
        taskId,
        deviceId: DEVICE_ID,
        start: toIso(instantOfWall(day, from + by, p.zone)),
        end: to === null ? null : toIso(instantOfWall(day, to + by, p.zone)),
        provisionalEnd: null,
        ...(subtask !== undefined ? { subtaskId: subtask } : {}),
      };
      s.segments.push(segment);
    });
  }

  // Tasks, with the end of their last segment as the time they were stopped.
  const lastEnd = new Map<string, string>();
  const firstStart = new Map<string, string>();
  for (const seg of s.segments) {
    if (seg.end !== null && seg.end > (lastEnd.get(seg.taskId) ?? '')) lastEnd.set(seg.taskId, seg.end);
    if (seg.start < (firstStart.get(seg.taskId) ?? '9')) firstStart.set(seg.taskId, seg.start);
  }
  for (const d of p.tasks) {
    const created = firstStart.get(d.id);
    const task: MockTask = {
      id: d.id,
      name: d.name,
      projectId: d.project,
      description: d.items ? subtaskDoc(d.items.map((i) => ({ id: i.id, text: i.text, checked: i.checked ?? false }))) : null,
      state: d.state,
      pauseReason: d.state === 'paused' ? { kind: 'user' } : null,
      createdAt: created ? toIso(parseIso(created) - 86_400) : '2026-11-05T09:00:00Z',
      stoppedAt: d.state === 'stopped' ? (lastEnd.get(d.id) ?? null) : null,
      runningElsewhere: null,
      continuedFrom: null,
      tags: [...d.tags],
      ...(d.active ? { activeSubtask: d.active } : {}),
    };
    const own = (d.items ?? []).filter((i) => i.tags !== undefined);
    if (own.length > 0) task.subtaskTags = Object.fromEntries(own.map((i) => [i.id, { tags: [...(i.tags ?? [])], stamp: { at: '2026-10-12T09:00:00Z', by: DEVICE_ID } }]));
    s.tasks.push(task);
  }

  // Summaries issued on earlier days, with the clock at the end of that working day.
  const nowSecs = s.now;
  for (const sum of p.summaries) {
    const project = p.projects.find((x) => x.id === sum.project);
    s.now = instantOfWall(sum.on, 18 * 60, p.zone);
    handle(s, 'create_summary', { request: { projectId: sum.project, from: sum.from, to: sum.to, zone: project?.clientZone ?? p.zone } });
  }
  s.now = nowSecs;

  s.settings = {
    myZone: p.zone,
    clientZone: p.client.zone,
    activeZone: p.zone,
    showBoth: false,
    clientWorkStart: p.client.from,
    clientWorkEnd: p.client.to,
    dailyTargetHours: p.targets.daily,
    weeklyTargetHours: p.targets.weekly,
  };
  s.clientZonePromptDone = true;
  s.syncPromptDone = true;
  s.nextId = 1000;
  s.warm = true;
  s.lastWorked = p.tasks.find((t) => t.state === 'running')?.id ?? null;
  return s;
}

/** The store a `?seed=store-…` query stands for. */
export function storeSeedState(seed: StoreSeed): MockState {
  switch (seed) {
    case 'store-web':
      return build(WEB);
    case 'store-swe':
      return build(SWE);
    case 'store-data':
      return build(DATA);
  }
}
