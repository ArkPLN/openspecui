/**
 * @file 共享请求与输入参数 Zod 校验 Schema
 * @description 统一前后端接口入参格式校验，包括工作区操作、远程 Git URL、Change 映射及 tasks.md 乐观锁更新。
 * @author ypc
 */

import { z } from 'zod';

/** 仓库来源类型 Schema */
export const RepoSourceTypeSchema = z.enum(['local', 'remote']);

/** 仓库角色类型 Schema */
export const RepoKindSchema = z.enum(['code', 'store', 'hybrid']);

/** 添加仓库请求 Schema */
export const AddRepoInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().min(1).max(40).default('CODE'),
    kind: RepoKindSchema.default('hybrid'),
    sourceType: RepoSourceTypeSchema,
    localPath: z.string().trim().min(1).optional(),
    remoteUrl: z.string().trim().min(1).optional(),
    autoSyncIntervalMinutes: z.number().int().min(0).max(1440).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.sourceType === 'local' && !val.localPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '本地仓库必须提供 localPath',
        path: ['localPath'],
      });
    }
    if (val.sourceType === 'remote' && !val.remoteUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '线上远程仓库必须提供 remoteUrl',
        path: ['remoteUrl'],
      });
    }
  });

/** 创建工作区请求 Schema */
export const CreateWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  repos: z.array(AddRepoInputSchema).default([]),
});

/** 更新工作区元数据请求 Schema */
export const UpdateWorkspaceInputSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
});

/** 创建跨仓项目关联组请求 Schema */
export const CreateRepoLinkInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  repoIds: z
    .array(z.string().min(1))
    .min(2)
    .refine((ids) => new Set(ids).size >= 2, '至少选择 2 个不同项目仓库'),
});

/** 创建跨仓 Change 映射请求 Schema */
export const CreateChangeLinkInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  members: z
    .array(
      z.object({
        repoId: z.string().min(1),
        changeName: z.string().min(1),
      }),
    )
    .min(2),
});

/** 设置 Change-Branch Pin 请求 Schema */
export const SetBranchPinInputSchema = z.object({
  changeKey: z.string().min(1),
  repoId: z.string().min(1),
  branch: z.string().trim().min(1).optional(),
  commitSha: z.string().trim().min(4).max(64).optional(),
});

/** 安全切换 Git 分支请求 Schema */
export const CheckoutBranchInputSchema = z.object({
  branch: z.string().trim().min(1).max(200),
});

/** tasks.md 单行乐观锁回写请求 Schema */
export const ToggleTaskInputSchema = z.object({
  repoId: z.string().min(1),
  changeName: z.string().min(1),
  archived: z.boolean().default(false),
  fileHash: z.string().min(16),
  lineNumber: z.number().int().min(1),
  expectedChecked: z.boolean(),
  nextChecked: z.boolean(),
  expectedRawLine: z.string().optional(),
});

/** 目录扫描请求 Schema */
export const ScanDirectoryInputSchema = z.object({
  rootPath: z.string().trim().min(1),
  maxDepth: z.number().int().min(1).max(4).default(2),
  onlyOpenSpec: z.boolean().default(true),
});

/** 创建 Idea 请求 Schema */
export const CreateIdeaInputSchema = z.object({
  repoId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).default(''),
});

/** 更新 Idea 请求 Schema */
export const UpdateIdeaInputSchema = z.object({
  repoId: z.string().trim().min(1).nullable().optional(),
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(2000).optional(),
});

/** 更新工作区自定义拖拽排序请求 Schema */
export const UpdateWorkspaceOrderInputSchema = z.object({
  repoIds: z.array(z.string().min(1)).optional(),
  changeOrder: z.array(z.string().min(1)).optional(),
  ideaOrder: z.array(z.string().min(1)).optional(),
});

/** Spec 演进历史查询参数 Schema */
export const SpecHistoryQuerySchema = z.object({
  capabilityPath: z.string().trim().min(1).max(240),
  limit: z.coerce.number().int().min(1).max(40).default(20),
});

export type AddRepoInput = z.infer<typeof AddRepoInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInputSchema>;
export type CreateRepoLinkInput = z.infer<typeof CreateRepoLinkInputSchema>;
export type CreateChangeLinkInput = z.infer<typeof CreateChangeLinkInputSchema>;
export type SetBranchPinInput = z.infer<typeof SetBranchPinInputSchema>;
export type CheckoutBranchInput = z.infer<typeof CheckoutBranchInputSchema>;
export type ToggleTaskInput = z.infer<typeof ToggleTaskInputSchema>;
export type ScanDirectoryInput = z.infer<typeof ScanDirectoryInputSchema>;
export type CreateIdeaInput = z.infer<typeof CreateIdeaInputSchema>;
export type UpdateIdeaInput = z.infer<typeof UpdateIdeaInputSchema>;
export type UpdateWorkspaceOrderInput = z.infer<typeof UpdateWorkspaceOrderInputSchema>;
export type SpecHistoryQuery = z.infer<typeof SpecHistoryQuerySchema>;
