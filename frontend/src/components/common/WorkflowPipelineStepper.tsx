import {
  ChevronRight,
  Clapperboard,
  ClipboardCheck,
  FileText,
  LayoutGrid,
  ListChecks,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { useI18n } from '@/i18n/useLocaleStore';
import { useProductionQueueStore } from '@/stores/useProductionQueueStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';

export type PipelineStageId =
  | 'script'
  | 'storyboard'
  | 'production'
  | 'scene_execution'
  | 'animation'
  | 'production_queue'
  | 'qc';

export function WorkflowPipelineStepper({ activeStage }: { activeStage: PipelineStageId }) {
  const { t } = useI18n();
  const project = useProjectStore((s) => s.project);
  const queue = useProductionQueueStore((s) => s.queue);
  const qcReport = useProductionQueueStore((s) => s.qcReport);
  const setActiveSubTab = useProductionQueueStore((s) => s.setActiveSubTab);
  const switchWorkspace = useWorkspaceStore((s) => s.switchWorkspace);
  const setTimelineCollapsed = useWorkspaceStore((s) => s.setTimelineCollapsed);

  const hasScript = Boolean(
    project?.script?.raw_source_text?.trim() || (project?.script?.scenes.length ?? 0) > 0,
  );
  const hasStoryboard = Boolean((project?.storyboard?.shots.length ?? 0) > 0);
  const hasPlan = Boolean((project?.production_plan?.shots.length ?? 0) > 0);
  const hasExecutedScenes = Boolean(project?.scenes.some((sc) => (sc.shots?.length ?? 0) > 0));
  const hasAnimations = Boolean((project?.timeline.keyframes.length ?? 0) > 0);
  const hasCompletedQueue = Boolean(
    queue?.tasks.some((tk) => tk.status === 'completed') ||
      project?.production_queue?.tasks.some((tk) => tk.status === 'completed'),
  );
  const qcReady = Boolean((qcReport ?? project?.qc_report)?.production_ready);

  const steps: Array<{
    id: PipelineStageId;
    label: string;
    icon: typeof FileText;
    done: boolean;
    onClick: () => void;
  }> = [
    {
      id: 'script',
      label: t('pipeline.script'),
      icon: FileText,
      done: hasScript,
      onClick: () => switchWorkspace('script'),
    },
    {
      id: 'storyboard',
      label: t('pipeline.storyboard'),
      icon: LayoutGrid,
      done: hasStoryboard,
      onClick: () => switchWorkspace('storyboard'),
    },
    {
      id: 'production',
      label: t('pipeline.productionPlan'),
      icon: ClipboardCheck,
      done: hasPlan,
      onClick: () => switchWorkspace('production'),
    },
    {
      id: 'scene_execution',
      label: t('pipeline.sceneExecution'),
      icon: Clapperboard,
      done: hasExecutedScenes,
      onClick: () => {
        switchWorkspace('scene');
        setTimelineCollapsed(false);
      },
    },
    {
      id: 'animation',
      label: t('pipeline.animation'),
      icon: Sparkles,
      done: hasAnimations,
      onClick: () => {
        switchWorkspace('animation');
        setTimelineCollapsed(false);
      },
    },
    {
      id: 'production_queue',
      label: t('pipeline.productionQueue'),
      icon: ListChecks,
      done: hasCompletedQueue,
      onClick: () => {
        setActiveSubTab('queue');
        switchWorkspace('production_queue');
      },
    },
    {
      id: 'qc',
      label: t('pipeline.qc'),
      icon: ShieldCheck,
      done: qcReady && Boolean(qcReport ?? project?.qc_report),
      onClick: () => {
        setActiveSubTab('qc');
        switchWorkspace('production_queue');
      },
    },
  ];

  return (
    <div
      className="prod-pipeline-stepper"
      data-testid="workflow-pipeline-stepper"
      style={{ flexWrap: 'wrap', gap: 4 }}
    >
      {steps.map((step, idx) => {
        const Icon = step.icon;
        const isActive = activeStage === step.id;
        return (
          <div key={step.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={`prod-step-pill ${isActive ? 'active' : ''} ${step.done ? 'done' : ''}`}
              onClick={step.onClick}
              data-testid={`pipeline-step-${step.id}`}
            >
              <Icon size={11} /> {step.label}
            </button>
            {idx < steps.length - 1 && <ChevronRight size={11} color="var(--text-muted)" />}
          </div>
        );
      })}
    </div>
  );
}
