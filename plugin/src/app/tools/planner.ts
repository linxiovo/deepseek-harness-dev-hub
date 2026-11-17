/** Planner Session tools: read only its handoff, request product clarification, and publish its specification. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { Handoffs } from '../handoffs.ts'
import { tool, type Tool } from './tool.ts'

export interface PlannerToolsHost {
  readonly handoffs: Pick<Handoffs, 'get' | 'spec' | 'isPlanning' | 'question' | 'publish'>
}

/** Refuse common requests for code organization or technology choices instead of forwarding implementation decisions to a person. */
const TECHNICAL_QUESTIONS = [
  // Files, modules, and code structure.
  /\b(?:which|what|where)\b.{0,60}\b(?:source files?|repository files?|modules?|classes?|packages?|folders?|directories?|codebase layers?|technical boundaries?|implementation details?)\b/i,
  /\b(?:which|what|where)\b.{0,60}\bfiles?\s+(?:(?:should|do)\s+we|to)\s+(?:edit|modify|place|put|create|organize|contain|own|use)\b/i,
  /\b(?:how|should we)\b.{0,60}\b(?:structure|organize|split|implement)\b.{0,60}\b(?:code|modules?|files?|packages?|architecture)\b/i,
  /\bhow\b.{0,60}\b(?:files?|modules?|folders?|packages?)\b.{0,60}\b(?:organized|structured|split)\b/i,
  /\b(?:file|files|folder|folders|directory|directories|module|modules|package|packages|class|classes|project|repo(?:sitory)?|codebase|code)\s+(?:structure|layout|organization|organisation|naming|names|placement|location|boundar(?:y|ies)|architecture|conventions?)\b|\b(?:naming conventions?|code organization|code structure|repo(?:sitory)? layout)\b/i,
  /\b(?:where|which)\b.{0,60}\b(?:should|does|do|would)\b.{0,40}\b(?:code|logic|implementation|module|class|function|helper|utility|parser|handler|adapter|controller|file)\b.{0,20}\b(?:live|belong|go|be (?:placed|defined|located)|sit)\b/i,
  /\b(?:what|how)\b.{0,40}\b(?:name|naming)\b.{0,40}\b(?:files?|modules?|classes?|functions?|variables?|packages?|methods?|helpers?)\b/i,
  // Tests, verification, and tooling.
  /\b(?:which|what|where|how|should\s+(?:I|we))\b.{0,100}\b(?:test(?:ing)?\s+(?:framework|runner|harness|interface|library|seam|setup|infrastructure)|assertion\s+(?:library|framework)|technical\s+(?:boundary|interface|seam)|jest|vitest|mocha|chai|playwright|cypress|jasmine)\b/i,
  /\b(?:choose|pick|select|use)\b.{0,60}\b(?:test(?:ing)?\s+(?:framework|runner|library|interface)|assertion\s+(?:library|framework))\b/i,
  /\b(?:unit|integration|end-to-end|e2e|regression|smoke|contract|snapshot)\s+(?:tests?|suites?|coverage)\b|\btests?\s+(?:coverage|suites?|runners?|harness|fixtures?|doubles?|config(?:uration)?|naming)\b|\b(?:test|spec)\s+(?:files?|director(?:y|ies)|folders?)\b/i,
  /\b(?:mocks?|mocking|stubs?|stubbing)\b.{0,30}\b(?:APIs?|database|network|fetch|HTTP|external services?|third-party|implementation|dependencies)\b/i,
  /\b(?:linters?|code formatters?|pre-commit hooks?|commit hooks?|code style|editorconfig|continuous integration|browser automation)\b/i,
  // API protocols, serialization, and named implementation tools.
  /\bREST(?:ful)?\b/,
  /\brest(?:ful)?\s+(?:APIs?|endpoints?|services?|routes?)\b/i,
  /\b(?:GraphQL|gRPC|JSON-?RPC|tRPC|WebSockets?|server-sent events|SSE|protobuf|protocol buffers?)\b/i,
  /\b(?:APIs?|endpoints?|payloads?|requests?|responses?)\b.{0,60}\b(?:JSON|XML|YAML)\b/i,
  /\b(?:APIs?|endpoints?)\s+(?:contracts?|design|schemas?|styles?|versioning|semantics|shape|protocols?|transports?)\b/i,
  /\b(?:which|what)\s+(?:(?:kind|type|sort)\s+of\s+)?(?:tech(?:nology)?\s+stack|stack|tooling|developer tools?|dev tools?|build tools?|build system|bundler|package manager|runtime|programming language|database|ORM|API style|architectural style|protocols?|transports?|serialization format|interface shape|deployment (?:target|platform|provider)|cloud provider|hosting)\b/i,
  /\b(?:UI|web|frontend|backend|JavaScript|TypeScript|CSS)\s+(?:framework|librar(?:y|ies))\b/i,
  /\b(?:which|what)\b.{0,40}\b(?:framework|librar(?:y|ies))\b.{0,40}\b(?:should\s+(?:I|we)|do\s+we)\b/i,
  /\b(?:PostgreSQL|Postgres|MySQL|SQLite|MongoDB|Redis|DynamoDB|Sequelize|TypeORM|Knex|Next\.js|Nuxt|NestJS|Fastify|PostCSS|styled-components|Redux|Zustand|Playwright|Selenium|Puppeteer|WebdriverIO|Appium|ESLint|Prettier|Webpack|Turbopack|pnpm|npm|Docker|Kubernetes|Terraform|Vitest|Vite|Vue|Jest)\b/,
  /\b(?:use|using|choose|choosing|pick|prefer|adopt|switch(?:ing)? to|migrate to|go with|instead of)\b.{0,40}\b(?:React|Svelte|Mocha|Cypress|Tailwind|Angular)\b/,
  // Deployment and hosting choices.
  /\b(?:AWS|GCP|Google Cloud|Amazon Web Services|Heroku|Vercel|Netlify|Cloudflare|DigitalOcean|Fly\.io)\b/i,
  /\b(?:host(?:ed|ing)?|deploy(?:ed|ing|ment)?|provision(?:ed|ing)?|infrastructure|cloud provider|servers?)\b.{0,40}\b(?:Azure|AWS|GCP)\b/,
  /\b(?:cloud|server|hosting|deployment|infrastructure)\s+(?:provider|platform|target|setup|architecture)\b/i,
  // Technical choices asked in Chinese.
  /(?:技术选型|技术栈|接口协议|通信协议|传输协议|序列化|单元测试|集成测试|端到端测试|测试覆盖率|测试框架|断言库|测试工具|目录结构|文件结构|代码结构|代码组织|命名规范|包管理器|构建工具|依赖注入|哪个协议|哪种协议|什么协议)/,
  /(?:如何|怎么|在哪|哪个|哪些).{0,16}(?:组织代码|划分模块|技术边界|代码文件|源文件|类文件|文件目录|文件结构)/,
]
const ProductQuestionSchema = z.string().trim().min(1)
  .refine(text => !TECHNICAL_QUESTIONS.some(pattern => pattern.test(text)), 'Ask only about product behavior or acceptance, not API protocols, technical boundaries, testing tools, or file organization')
  .describe('One unanswered product behavior or acceptance decision for the user; never ask them to choose API protocols, files, modules, architecture, test frameworks, assertion libraries, or other implementation details.')
const SpecInputSchema = z.object({
  body: z.string().trim().min(1).describe('One implementable product specification for this handoff’s confirmed goal, not a bundle of unrelated intents.'),
  acceptance: z.array(z.object({ statement: z.string().trim().min(1), observable: z.string().trim().min(1) }).strict()).min(1)
    .describe('User-visible, observable acceptance criteria for the one confirmed product intent.'),
  testInterfaces: z.array(z.object({ seam: z.string().trim().min(1), kind: z.enum(['existing', 'proposed']),
    note: z.string().trim().min(1) }).strict()).min(1).describe('At least one existing or proposed public test interface for the confirmed product intent.'),
  outOfScope: z.array(z.string().trim().min(1)).describe('Explicit exclusions, not additional product goals.'),
}).strict()

/** Installs only tools scoped to the persisted handoff named by this planner Session ID. */
export function plannerTools(host: PlannerToolsHost, agent: Agent): Tool[] {
  const handoffId = agent.id.startsWith('planner-') ? agent.id.slice('planner-'.length) : ''
  if (!handoffId || !host.handoffs.get(handoffId)) throw new Error('Planner tools require a persisted planner-<handoffId> Session')
  const assertPlanning = (id: string) => {
    if (agent.id !== `planner-${id}` || id !== handoffId || !host.handoffs.isPlanning(id)) {
      throw new Error('Only the active planner Session for this handoff may use this tool')
    }
  }
  return [
    tool({
      name: 'orchestrator_read',
      description: 'Read only this planner Session’s persisted handoff or its published specification; no other Hub or worker resources are available.',
      schema: z.object({ resource: z.enum([`handoff/${handoffId}`, `spec/${handoffId}`]) }).strict(),
      execute: async ({ resource }) => {
        assertPlanning(handoffId)
        return resource.startsWith('handoff/') ? host.handoffs.get(handoffId)
          : host.handoffs.spec(handoffId) ?? { handoffId, status: 'pending' }
      },
    }),
    tool({
      name: 'orchestrator_spec_question',
      description: 'Persist one user-facing product clarification for this handoff, then relay it to the Hub to ask the user. Do not request API protocols, technical boundaries, file organization, architecture, or implementation choices.',
      schema: z.object({ handoffId: z.string().trim().min(1), text: ProductQuestionSchema,
        why: z.string().trim().min(1).describe('Why the product decision is necessary for this handoff’s acceptance.'),
        affectedAcceptance: z.array(z.string().trim().min(1)).min(1).describe('Copy each affected criterion verbatim from this handoff’s confirmed acceptanceScope; paraphrases or new criteria are rejected.') }).strict(),
      execute: async ({ handoffId: id, text, why, affectedAcceptance }) => {
        assertPlanning(id)
        const question = host.handoffs.question(id, { text, why, affectedAcceptance }).question
        if (!question) throw new Error('Persisted planner question is unavailable')
        return { handoffId: id, question, handoff: `handoff/${id}` }
      },
    }),
    tool({
      name: 'orchestrator_spec_publish',
      description: 'Publish one finished specification for this confirmed handoff with observable acceptance, test interfaces, and exclusions. No unrelated goal or release authorization is granted.',
      schema: z.object({ handoffId: z.string().trim().min(1), ...SpecInputSchema.shape }).strict(),
      execute: async ({ handoffId: id, ...input }) => {
        assertPlanning(id)
        const spec = host.handoffs.publish(id, input).spec
        if (!spec) throw new Error('Published specification is unavailable')
        return { handoffId: id, spec, read: `spec/${id}` }
      },
    }),
  ]
}
