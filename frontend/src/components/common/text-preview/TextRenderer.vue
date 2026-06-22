<template>
  <div class="text-renderer" :class="{ 'dark-mode': darkMode }">
    <!-- 内容区域 -->
    <div class="content-area" :style="contentStyle">
      <!-- 空内容 -->
      <div v-if="!content && mode !== 'edit'" class="empty-state">
        <div class="empty-icon">📄</div>
        <p class="empty-message" :class="textClass">内容为空</p>
      </div>

      <!-- 文本内容 -->
      <div v-else class="text-content">
        <!-- 纯文本模式 -->
        <TextDisplay v-if="mode === 'text'" :content="content" :dark-mode="darkMode" />

        <!-- 代码高亮模式 -->
        <CodeDisplay v-else-if="mode === 'code'" :content="content" :language="language" :dark-mode="darkMode" :show-line-numbers="showLineNumbers" :filename="filename" />

        <!-- Markdown模式 -->
        <MarkdownDisplay v-else-if="mode === 'markdown'" :content="content" :dark-mode="darkMode" />

        <!-- HTML模式 -->
        <HtmlDisplay v-else-if="mode === 'html'" :content="content" :dark-mode="darkMode" />

        <!-- 编辑模式 -->
        <TextEditor
          v-else-if="mode === 'edit'"
          :content="content"
          :language="language"
          :dark-mode="darkMode"
          :read-only="readOnly"
          @change="handleContentChange"
          @save="handleSave"
        />

        <!-- 未知模式，降级到纯文本 -->
        <TextDisplay v-else :content="content" :dark-mode="darkMode" />
      </div>

      <!-- 文本统计信息 -->
      <div v-if="showStats && content" class="text-stats-footer" :class="{ 'stats-dark': darkMode }">
        <span class="stat-item">{{ lineCount }} L</span>
        <span class="stat-item">{{ characterCount }} Chars</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import TextDisplay from "./TextDisplay.vue";
import CodeDisplay from "./CodeDisplay.vue";
import HtmlDisplay from "./HtmlDisplay.vue";
import MarkdownDisplay from "./MarkdownDisplay.vue";
import TextEditor from "./TextEditor.vue";

// Props
const props = defineProps({
  // 文本内容
  content: {
    type: String,
    required: true,
  },
  // 渲染模式
  mode: {
    type: String,
    default: "text",
    validator: (value) => ["text", "code", "markdown", "html", "edit"].includes(value),
  },
  // 代码语言（仅代码模式需要）
  language: {
    type: String,
    default: "",
  },
  // 文件名（用于语言检测）
  filename: {
    type: String,
    default: "",
  },
  // 是否暗色模式
  darkMode: {
    type: Boolean,
    default: false,
  },
  // 是否显示行号（代码模式）
  showLineNumbers: {
    type: Boolean,
    default: true,
  },
  // 是否只读（编辑模式）
  readOnly: {
    type: Boolean,
    default: true,
  },

  // 最大高度
  maxHeight: {
    type: [Number, String],
    default: 600,
  },
  // 是否显示统计信息
  showStats: {
    type: Boolean,
    default: true,
  },
});

// Emits
const emit = defineEmits(["content-change", "save"]);

// 计算属性
const contentStyle = computed(() => {
  const styles = {};
  if (props.maxHeight) {
    styles.maxHeight = typeof props.maxHeight === "number" ? `${props.maxHeight}px` : props.maxHeight;
  }
  return styles;
});

const textClass = computed(() => ({
  "text-dark": props.darkMode,
  "text-light": !props.darkMode,
}));

//缓存统计信息计算
const textStats = computed(() => {
  if (!props.content) {
    return { lineCount: 0, characterCount: 0 };
  }

  // 一次遍历计算所有统计信息，避免重复分割字符串
  let lineCount = 1;
  const characterCount = props.content.length;

  // 只在需要行数时才进行字符串遍历
  for (let i = 0; i < characterCount; i++) {
    if (props.content[i] === "\n") {
      lineCount++;
    }
  }

  return { lineCount, characterCount };
});

const lineCount = computed(() => textStats.value.lineCount);
const characterCount = computed(() => textStats.value.characterCount);

// 方法
const handleContentChange = (newContent) => {
  emit("content-change", newContent);
};

const handleSave = (content) => {
  emit("save", content);
};
</script>

<style scoped>
.text-renderer {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.text-renderer.dark-mode {
  background-color: #1f2937;
}

/* 内容区域样式 */
.content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 400px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 2rem;
}

.empty-icon {
  font-size: 2.25rem;
  margin-bottom: 1rem;
}

.empty-message {
  color: #6b7280;
}

.text-dark {
  color: #d1d5db;
}

/* 文本内容样式 */
.text-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0; /* 关键：防止flex项目无限扩展 */
}

/* 统计信息样式 */
.text-stats-footer {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid #e5e7eb;
  background-color: #f9fafb;
  font-size: 0.875rem;
  color: #6b7280;
}

.text-stats-footer.stats-dark {
  border-top-color: #374151;
  background-color: #1f2937;
  color: #9ca3af;
}

.stat-item {
  white-space: nowrap;
}
</style>
