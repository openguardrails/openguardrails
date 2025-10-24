# Contributing Guide

Thank you for your interest in OpenGuardrails! We welcome and greatly appreciate contributions of all kinds.

## How to Contribute

We welcome the following types of contributions:

### 🐛 Bug Reports
- Any issues encountered during usage
- Errors or inaccuracies in documentation
- Performance issues or abnormal behavior

### 💡 Feature Suggestions
- Ideas and suggestions for new features
- Improvement suggestions for existing features
- User experience optimization suggestions

### 📖 Documentation Improvements
- Fix documentation errors
- Add usage examples
- Translate documentation to other languages
- Improve code comments

### 💻 Code Contributions
- Bug fixes
- New feature development
- Performance optimizations
- Adding test cases

## Development Environment Setup

### 1. Fork the Project
Click the "Fork" button in the top right corner of the GitHub page

### 2. Clone the Code
```bash
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails
```

### 3. Set Up Upstream Repository
```bash
git remote add upstream https://github.com/openguardrails/openguardrails.git
```

### 4. Install Development Dependencies

**Backend Development Environment:**
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

**Frontend Development Environment:****
```bash
cd frontend
npm install
```

### 5. Start Development Services
```bash
# Start backend services (3 separate terminals)
# Terminal 1 - Admin Service
cd backend
python start_admin_service.py

# Terminal 2 - Detection Service
cd backend
python start_detection_service.py

# Terminal 3 - Proxy Service
cd backend
python start_proxy_service.py

# Terminal 4 - Frontend
cd frontend
npm run dev
```

## Development Workflow

### 1. Create Feature Branch
```bash
git checkout -b feature/your-feature-name
# Or bug fix branch
git checkout -b fix/your-bug-fix
```

### 2. Develop
- Follow existing code style
- Write clear code comments
- Add appropriate test cases
- Ensure code passes existing tests

#### 3. Commit Code
```bash
git add .
git commit -m "feat: add new feature description"
# Or
git commit -m "fix: fix bug description"
```

**Commit Message Format:**
- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation updates
- `style:` Code formatting adjustments
- `refactor:` Code refactoring
- `test:` Test-related
- `chore:` Build process or auxiliary tool changes

### 4. Push to GitHub
```bash
git push origin feature/your-feature-name
```

### 5. Create Pull Request
1. Visit your forked repository page
2. Click "Compare & pull request"
3. Fill in PR description explaining:
   - What was changed and why
   - Related Issue numbers
   - Testing methods
   - Screenshots (if UI changes)

## Code Standards

### Python Code Standards
- Follow PEP 8 style guide
- Use black for code formatting
- Use flake8 for code linting
- Functions and classes should have docstrings

```python
def example_function(param1: str, param2: int) -> bool:
    """
    Example function description
    
    Args:
        param1: Parameter 1 description
        param2: Parameter 2 description
        
    Returns:
        Return value description
    """
    # Implementation code
    pass
```

### TypeScript/React Code Standards
- Use ESLint and Prettier
- Use TypeScript strict mode
- Components should have PropTypes or TypeScript type definitions
- Use functional components and Hooks

```typescript
interface Props {
  title: string;
  onClick: () => void;
}

const ExampleComponent: React.FC<Props> = ({ title, onClick }) => {
  return (
    <button onClick={onClick}>
      {title}
    </button>
  );
};
```

## Getting Help

If you need help:

- 📧 Send email to: thomas@openguardrails.com
- 💬 Ask questions in GitHub Discussion
- 🐛 Report issues in GitHub Issues
- 📖 Check project Wiki and documentation

---

*Thank you for contributing to making AI safer and more trustworthy!* 🙏