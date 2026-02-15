/**
 * Simple test for the gateway sanitizer
 */

import { sanitize } from "./sanitizer.js";
import { restore } from "./restorer.js";

// Test case 1: Simple message with bank card
const test1 = {
  messages: [
    {
      role: "user",
      content: "我的银行卡号是 6222021234567890，请帮我订酒店",
    },
  ],
};

console.log("=== Test 1: Bank Card Sanitization ===");
console.log("Original:", JSON.stringify(test1, null, 2));

const result1 = sanitize(test1.messages);
console.log("\nSanitized:", JSON.stringify(result1.sanitized, null, 2));
console.log("\nMapping Table:");
result1.mappingTable.forEach((original, placeholder) => {
  console.log(`  ${placeholder} → ${original}`);
});

const restored1 = restore(result1.sanitized, result1.mappingTable);
console.log("\nRestored:", JSON.stringify(restored1, null, 2));

// Test case 2: Multiple sensitive data types
const test2 = {
  messages: [
    {
      role: "user",
      content: "我的邮箱是 user@example.com，卡号 6222021234567890，手机 +86-138-1234-5678",
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "好的，我收到了您的信息" },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "123",
          content: "API key: sk-1234567890abcdef",
        },
      ],
    },
  ],
};

console.log("\n\n=== Test 2: Multiple Data Types ===");
console.log("Original:", JSON.stringify(test2, null, 2));

const result2 = sanitize(test2.messages);
console.log("\nSanitized:", JSON.stringify(result2.sanitized, null, 2));
console.log("\nMapping Table:");
result2.mappingTable.forEach((original, placeholder) => {
  console.log(`  ${placeholder} → ${original}`);
});

const restored2 = restore(result2.sanitized, result2.mappingTable);
console.log("\nRestored:", JSON.stringify(restored2, null, 2));

// Verification
console.log("\n\n=== Verification ===");
console.log("Test 1 matches:", JSON.stringify(test1.messages) === JSON.stringify(restored1));
console.log("Test 2 matches:", JSON.stringify(test2.messages) === JSON.stringify(restored2));
