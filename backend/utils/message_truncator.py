import random
from typing import List
from models.requests import Message
from config import settings

class MessageTruncator:
    """Message truncator tool, used to control the maximum context length of the detection interface"""
    
    @staticmethod
    def calculate_total_content_length(messages: List[Message]) -> int:
        """Calculate the total length of all message contents"""
        return sum(len(msg.content) for msg in messages)
    
    @staticmethod
    def get_random_window(content: str, max_length: int) -> str:
        """Randomly select a continuous window from the content"""
        if len(content) <= max_length:
            return content
        
        # Randomly select starting position
        start_pos = random.randint(0, len(content) - max_length)
        return content[start_pos:start_pos + max_length]
    
    @staticmethod
    def truncate_messages(messages: List[Message]) -> List[Message]:
        """
        Truncate messages based on the maximum context length configured
        
        策略：
        1. If the last round is user or only one round, prioritize keeping the last user message
        2. If the last round is assistant, ensure it starts with user
        3. Use random window to resist long text attacks
        4. Consider user-assistant pairs
        """
        # Ensure messages is not empty
        if not messages:
            return messages
        
        # Ensure the first message is user role (before length check)
        if messages[0].role != 'user':
            # If the first message is not user, find the first user message
            first_user_index = -1
            for i, msg in enumerate(messages):
                if msg.role == 'user':
                    first_user_index = i
                    break
            
            if first_user_index == -1:
                # No user message found, return empty list
                return []
            
            # Rebuild messages list from the first user message
            messages = messages[first_user_index:]
        
        max_length = settings.max_detection_context_length
        total_length = MessageTruncator.calculate_total_content_length(messages)
        
        if total_length <= max_length:
            return messages
        
        last_message = messages[-1]
        
        if last_message.role == 'user':
            return MessageTruncator._truncate_ending_with_user(messages, max_length)
        elif last_message.role == 'assistant':
            return MessageTruncator._truncate_ending_with_assistant(messages, max_length)
        else:
            # system message and other cases, treated as user
            return MessageTruncator._truncate_ending_with_user(messages, max_length)
    
    @staticmethod
    def _truncate_ending_with_user(messages: List[Message], max_length: int) -> List[Message]:
        """Handle the case where the last round is user"""
        last_user = messages[-1]
        
        # If the last user content exceeds the configured value, randomly select a window
        if len(last_user.content) > max_length:
            truncated_content = MessageTruncator.get_random_window(last_user.content, max_length)
            return [Message(role=last_user.role, content=truncated_content)]
        
        # If the last user content does not exceed the configured value, try to include more historical dialogs
        result = [last_user]
        remaining_length = max_length - len(last_user.content)
        
        # Traverse from back to front, process user-assistant pairs
        i = len(messages) - 2  # Start from the second last
        
        while i >= 0:
            # Find user-assistant pairs
            if i > 0 and messages[i].role == 'assistant' and messages[i-1].role == 'user':
                # Find a user-assistant pair
                user_msg = messages[i-1]
                assistant_msg = messages[i]
                pair_length = len(user_msg.content) + len(assistant_msg.content)
                
                if pair_length <= remaining_length:
                    # Can include this pair
                    result.insert(0, assistant_msg)
                    result.insert(0, user_msg)
                    remaining_length -= pair_length
                    i -= 2
                else:
                    # This pair is too long, stop
                    break
            elif i == 0 and messages[i].role == 'user':
                # Only one user message
                if len(messages[i].content) <= remaining_length:
                    result.insert(0, messages[i])
                break
            else:
                # Not expected message sequence, skip
                i -= 1
        
        return result
    
    @staticmethod
    def _truncate_ending_with_assistant(messages: List[Message], max_length: int) -> List[Message]:
        """Handle the case where the last round is assistant"""
        if len(messages) < 2:
            # If there are not enough messages to form user-assistant pairs, return empty
            return []
        
        last_assistant = messages[-1]
        
        # Find the last user message
        last_user_index = -1
        for i in range(len(messages) - 2, -1, -1):
            if messages[i].role == 'user':
                last_user_index = i
                break
        
        if last_user_index == -1:
            # No user message found, cannot form a valid sequence
            return []
        
        last_user = messages[last_user_index]
        
        # If the assistant content itself exceeds the configured value
        if len(last_assistant.content) > max_length:
            # Check user content length
            if len(last_user.content) > max_length // 3:
                # User content exceeds 1/3, randomly select 1/3 length of user and 2/3 length of assistant
                user_max_len = max_length // 3
                assistant_max_len = max_length - user_max_len
                
                user_content = MessageTruncator.get_random_window(last_user.content, user_max_len)
                assistant_content = MessageTruncator.get_random_window(last_assistant.content, assistant_max_len)
                
                return [
                    Message(role='user', content=user_content),
                    Message(role='assistant', content=assistant_content)
                ]
            else:
                # User content does not exceed 1/3, keep all user, truncate assistant
                assistant_max_len = max_length - len(last_user.content)
                assistant_content = MessageTruncator.get_random_window(last_assistant.content, assistant_max_len)
                
                return [
                    Message(role='user', content=last_user.content),
                    Message(role='assistant', content=assistant_content)
                ]
        
        # Assistant content does not exceed the configured value, keep all assistant
        last_pair_length = len(last_user.content) + len(last_assistant.content)
        
        if last_pair_length > max_length:
            # The last pair exceeds the limit, need to truncate user
            user_max_len = max_length - len(last_assistant.content)
            user_content = MessageTruncator.get_random_window(last_user.content, user_max_len)
            
            return [
                Message(role='user', content=user_content),
                Message(role='assistant', content=last_assistant.content)
            ]
        
        # The last pair does not exceed the limit, try to include more historical dialogs
        result = [last_user, last_assistant]
        remaining_length = max_length - last_pair_length
        
        # Process historical dialogs from last_user before, pair by pair
        i = last_user_index - 1
        
        while i >= 0:
            # Find user-assistant pairs
            if i > 0 and messages[i].role == 'assistant' and messages[i-1].role == 'user':
                # Find a user-assistant pair
                user_msg = messages[i-1]
                assistant_msg = messages[i]
                pair_length = len(user_msg.content) + len(assistant_msg.content)
                
                if pair_length <= remaining_length:
                    # Can include this pair
                    result.insert(0, assistant_msg)
                    result.insert(0, user_msg)
                    remaining_length -= pair_length
                    i -= 2
                else:
                    # This pair is too long, stop
                    break
            elif i == 0 and messages[i].role == 'user':
                # Only one user message
                if len(messages[i].content) <= remaining_length:
                    result.insert(0, messages[i])
                break
            else:
                # Not expected message sequence, skip
                i -= 1
        
        return result