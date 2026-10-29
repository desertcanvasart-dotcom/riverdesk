import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { runOnce } from 'graphile-worker';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import {
  createDemoPricing,
  createDemoVessel,
  createPendingDocument,
  downloadDocument,
  generateSchedule,
  getDocumentStatus,
  openDatabase,
  requestDocument,
  staffBook,
  type VsDatabase,
} from '@vs/engine';
import { addDays, connectionString, createLogger, roleConnection, systemActor } from '@vs/shared';
import { closeRenderer } from '../src/documents/render';
import { renderDocument } from '../src/tasks/document-jobs';
import { buildTaskList } from '../src/worker';

const logger = createLogger('documents-test', { level: 'silent' });

describe('documents (requested by staff, rendered by the worker)', () => {
  const config = testConfig();
  const workerUrl = connectionString(roleConnection(config, 'vs_worker', { session: true }));
  const ctx = { operatorId: '', actor: systemActor('test') };
  let worker: VsDatabase;
  let backoffice: VsDatabase;
  let bookingId: string;
  let legId: string;

  beforeAll(async () => {
    worker = openDatabase('vs_worker', { config, max: 2 });
    backoffice = openDatabase('vs_backoffice', { config, max: 2 });
    ctx.operatorId = await createOperator('Documents operator');
    const demo = await createDemoVessel(backoffice, ctx);
    await generateSchedule(backoffice, ctx, {
      vesselId: demo.vesselId,
      until: addDays(demo.validFrom, 20),
    });
    const pricing = await createDemoPricing(backoffice, ctx, demo.vesselId);
    const sailing = (
      await owner().query<{ id: string; leg_id: string }>(
        `select s.id, sl.leg_id from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id
         join vs.sailing_leg sl on sl.sailing_id = s.id and sl.seq = 0
         where s.vessel_id = $1 and sp.code = 'LXR-4' order by s.embark_date limit 1`,
        [demo.vesselId],
      )
    ).rows[0]!;
    legId = sailing.leg_id;
    const booked = await staffBook(backoffice, ctx, {
      channelId: pricing.channels.nilecrz,
      sailingId: sailing.id,
      market: 'international',
      cabins: [{ categoryId: demo.categories.STD, adults: 2, childAges: [7] }],
      guests: [
        {
          cabin: 0,
          firstName: 'Mona',
          lastName: 'Hassan',
          lead: true,
          passportNumber: 'A12345678',
        },
        { cabin: 0, firstName: 'Karim', lastName: 'Hassan', passportNumber: 'B87654321' },
      ],
      requestKey: 'documents-test-0001',
    });
    bookingId = booked.bookingId;
  }, 120_000);

  afterAll(async () => {
    await closeRenderer();
    await worker.close();
    await backoffice.close();
  });

  async function render(input: Parameters<typeof requestDocument>[2]) {
    const { documentId } = await requestDocument(backoffice, ctx, input);
    expect((await getDocumentStatus(backoffice, ctx, documentId)).status).toBe('pending');
    await runOnce({ connectionString: workerUrl, taskList: buildTaskList(worker, logger) });
    expect(await getDocumentStatus(backoffice, ctx, documentId)).toMatchObject({ status: 'ready' });
    return downloadDocument(backoffice, ctx, documentId);
  }

  it('renders the voucher as a PDF in Arabic and English', async () => {
    for (const locale of ['ar', 'en'] as const) {
      const file = await render({ kind: 'voucher', bookingId, locale });
      expect(file.contentType).toBe('application/pdf');
      expect(file.content.subarray(0, 4).toString()).toBe('%PDF');
      expect(file.filename).toMatch(new RegExp(`voucher-${locale}\\.pdf$`));
    }
  }, 60_000);

  it('puts passports in the manifest export only, and audits its download', async () => {
    const manifest = await render({ kind: 'manifest', legId, locale: 'en', format: 'xlsx' });
    const rooming = await render({ kind: 'rooming_list', legId, locale: 'en', format: 'xlsx' });
    const text = async (content: Buffer) => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(content as unknown as ArrayBuffer);
      const values: string[] = [];
      workbook.worksheets[0]!.eachRow((row) => values.push(JSON.stringify(row.values)));
      return values.join('\n');
    };
    expect(await text(manifest.content)).toContain('A12345678');
    const roomingText = await text(rooming.content);
    expect(roomingText).not.toContain('A12345678');
    expect(roomingText).toContain('Mona Hassan');
    const audited = await owner().query(
      `select 1 from vs.audit_log where operator_id = $1 and action = 'document.downloaded'`,
      [ctx.operatorId],
    );
    expect(audited.rowCount).toBe(1);
    const logged = await owner().query(
      `select 1 from vs.audit_log where operator_id = $1 and diff::text like '%A12345678%'`,
      [ctx.operatorId],
    );
    expect(logged.rowCount).toBe(0);
  }, 60_000);

  it('renders the vacancy sheet as PDF, spreadsheet and image', async () => {
    const vesselId = (
      await owner().query<{ id: string }>(`select id from vs.vessel where operator_id = $1`, [
        ctx.operatorId,
      ])
    ).rows[0]!.id;
    const from = new Date().toISOString().slice(0, 10);
    const png = await render({
      kind: 'vacancy_sheet',
      vesselId,
      from,
      locale: 'ar',
      format: 'png',
    });
    expect(png.content.subarray(1, 4).toString()).toBe('PNG');
    const xlsx = await render({
      kind: 'vacancy_sheet',
      vesselId,
      from,
      locale: 'en',
      format: 'xlsx',
    });
    expect(xlsx.content.subarray(0, 2).toString()).toBe('PK');
  }, 60_000);

  it('builds the nightly outage pack: 14 days of availability and departure manifests', async () => {
    const vesselId = (
      await owner().query<{ id: string }>(`select id from vs.vessel where operator_id = $1`, [
        ctx.operatorId,
      ])
    ).rows[0]!.id;
    const doc = await createPendingDocument(worker, ctx, {
      kind: 'outage_pack',
      vesselId,
      locale: 'ar',
    });
    const file = await renderDocument(worker, ctx, doc);
    expect(file.content.subarray(0, 4).toString()).toBe('%PDF');
    expect(file.filename).toMatch(/^outage-pack-\d{4}-\d{2}-\d{2}-ar\.pdf$/);
  }, 60_000);

  it('refuses to queue a document of another company', async () => {
    const other = await createOperator('Other documents operator');
    const result = await requestDocument(
      backoffice,
      { operatorId: other, actor: ctx.actor },
      {
        kind: 'voucher',
        bookingId,
        locale: 'en',
      },
    ).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('exports an Analytics tab to Excel, with money only when asked', async () => {
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const render = async (withMoney: boolean) => {
      const file = await renderDocument(worker, ctx, {
        id: 'analytics',
        kind: 'analytics_export',
        format: 'xlsx',
        locale: 'en',
        variant: withMoney ? 'full' : 'agent',
        entityId: ctx.operatorId,
        params: { report: 'channels', filter: { from, to: from }, withMoney },
      });
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
      return { file, workbook };
    };
    const plain = await render(false);
    expect(plain.file.filename).toMatch(/^analytics-channels-.*-en\.xlsx$/);
    expect(plain.workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Analytics- channels and markets',
      'Markets',
      'Nationalities',
      'Allotments',
    ]);
    const headers = (wb: ExcelJS.Workbook) =>
      (wb.worksheets[0]!.getRow(4).values as unknown[]).filter(Boolean);
    expect(headers(plain.workbook)).not.toContain('Guest value');
    expect(plain.workbook.worksheets[0]!.getRow(5).getCell(1).value).toBe('nilecrz');
    expect(headers((await render(true)).workbook)).toContain('Guest value');
  });

  it('exports the Cash tab: cash in, still to be paid, by method, held', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const file = await renderDocument(worker, ctx, {
      id: 'cash',
      kind: 'analytics_export',
      format: 'xlsx',
      locale: 'en',
      variant: 'full',
      entityId: ctx.operatorId,
      params: { report: 'cash', filter: { from: today, to: today, grain: 'day' }, withMoney: true },
    });
    expect(file.filename).toMatch(/^analytics-cash-.*-en\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Cash in',
      'By method',
      'Still to be paid, by when it fa',
      'Held for future sailings',
    ]);
  });

  it('exports the Revenue tab: revenue, leakage, exposure, base currency', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const file = await renderDocument(worker, ctx, {
      id: 'revenue',
      kind: 'analytics_export',
      format: 'xlsx',
      locale: 'en',
      variant: 'full',
      entityId: ctx.operatorId,
      params: {
        report: 'revenue',
        filter: { basis: 'sailing', from: today, to: today, groupBy: 'channel' },
        withMoney: true,
      },
    });
    expect(file.filename).toMatch(/^analytics-revenue-.*-en\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Revenue',
      'Leakage',
      'Currency exposure',
      'In the base currency',
    ]);
  });

  it('exports the Receivables tab: by party and credit used', async () => {
    const file = await renderDocument(worker, ctx, {
      id: 'receivables',
      kind: 'analytics_export',
      format: 'xlsx',
      locale: 'en',
      variant: 'full',
      entityId: ctx.operatorId,
      params: { report: 'receivables', filter: {}, withMoney: true },
    });
    expect(file.filename).toMatch(/^analytics-receivables-.*-en\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.content as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual([
      'Receivables by party',
      'Credit used',
    ]);
  });
});
