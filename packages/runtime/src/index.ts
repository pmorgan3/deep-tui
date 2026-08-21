import type { Context } from 'cordis'
import {
  AuditService,
  AgentLifecycleService,
  BillingService,
  CommandService,
  ConversationService,
  ModelService,
  PermissionService,
  PermissionRuleService,
  ProjectService,
  PromptService,
  ThemeService,
  TuiService,
  ToolService,
  UiService,
  WorkspaceService,
} from '@flect/sdk'

export const name = 'flect-runtime'

export function apply(ctx: Context): void {
  if (!ctx.get('project')) ctx.plugin(ProjectService)
  ctx.plugin(CommandService)
  ctx.plugin(AuditService)
  ctx.plugin(AgentLifecycleService)
  ctx.plugin(BillingService)
  ctx.plugin(ConversationService)
  ctx.plugin(ModelService)
  ctx.plugin(ToolService)
  ctx.plugin(WorkspaceService)
  ctx.plugin(PromptService)
  ctx.plugin(PermissionService)
  ctx.plugin(PermissionRuleService)
  ctx.plugin(ThemeService)
  ctx.plugin(UiService)
  ctx.plugin(TuiService)
}

export default { name, apply }
