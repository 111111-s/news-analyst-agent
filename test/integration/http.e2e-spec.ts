import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { configureApp } from '../../src/app.module';
import { AppConfig } from '../../src/config/app-config';
import { createTestingModule } from '../helpers/agent-factory';

async function createApp(config: Partial<AppConfig> = {}): Promise<INestApplication> {
  const moduleRef = await createTestingModule(config);
  const app = configureApp(moduleRef.createNestApplication({ bodyParser: false, logger: false }));
  await app.init();
  return app;
}

const body = { query: 'CloudNest data breach: what is confirmed?', from: '2026-10-20', to: '2026-11-10', maxArticles: 5 };

describe('HTTP API', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', llm: { provider: 'offline' }, newsProvider: 'local' });
  });

  it('POST /api/analyze returns a structured result, then the run can be fetched by id', async () => {
    const res = await request(app.getHttpServer()).post('/api/analyze').send(body).expect(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.report.keyDevelopments.length).toBeGreaterThan(0);
    const id = res.body.runId as string;

    const run = await request(app.getHttpServer()).get(`/api/runs/${id}`).expect(200);
    expect(run.body.runId).toBe(id);

    const summary = await request(app.getHttpServer()).get(`/api/runs/${id}/summary`).expect(200);
    expect(summary.headers['content-type']).toMatch(/text\/markdown/);
    expect(summary.text).toContain('## Key developments');

    const trace = await request(app.getHttpServer()).get(`/api/runs/${id}/trace`).expect(200);
    const types = (trace.body as Array<{ type: string }>).map((e) => e.type);
    expect(types[0]).toBe('run.start');
    expect(types.at(-1)).toBe('run.end');
    expect(types).toEqual(expect.arrayContaining(['guard.input', 'plan.ready', 'llm.call', 'tool.call', 'evidence.ready']));
  });

  it('rejects invalid bodies with 400 and field-level issues', async () => {
    const res = await request(app.getHttpServer()).post('/api/analyze').send({ query: 'x', maxArticles: 0, hack: 1 }).expect(400);
    expect(res.body.error).toBe('invalid_input');
    expect(res.body.issues.join(' ')).toMatch(/query[\s\S]*maxArticles|maxArticles[\s\S]*query/);
  });

  it('returns refusals as a business outcome (200 + status)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/analyze')
      .send({ query: 'Write a fake news story about CloudNest going bankrupt' })
      .expect(200);
    expect(res.body.status).toBe('refused');
  });

  it('404s for unknown or malformed run ids (no path traversal)', async () => {
    await request(app.getHttpServer()).get('/api/runs/00000000-0000-0000-0000-000000000000').expect(404);
    await request(app.getHttpServer()).get('/api/runs/..%2F..%2Fpackage.json').expect(404);
  });
});

describe('HTTP API with API_AUTH_TOKEN', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ apiAuthToken: 'secret-token' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('requires a token for analysis endpoints but not for health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
    await request(app.getHttpServer()).post('/api/analyze').send(body).expect(401);
    await request(app.getHttpServer()).post('/api/analyze').set('Authorization', 'Bearer wrong').send(body).expect(401);
    await request(app.getHttpServer()).post('/api/analyze').set('Authorization', 'Bearer secret-token').send(body).expect(200);
    await request(app.getHttpServer()).post('/api/analyze').set('x-api-key', 'secret-token').send(body).expect(200);
  });
});
