# OpenGuardrails AI-RSMS  
## ISO-style PDF Build Guide

This repository contains the ISO-style specification for the **OpenGuardrails AI Runtime Security Management System (AI-RSMS)**.

The specification is authored in Markdown and rendered into a publication-ready PDF using **Pandoc + LaTeX (XeLaTeX)**, following an ISO/IEC-aligned structure, terminology, and layout.

---

## Source Files

The following files are required to build the PDF:

| File | Description |
|------|-------------|
| `OG-AI-RSMS-001.md` | Normative specification content (Markdown, ISO structure) |
| `iso-style.tex` | ISO-style LaTeX template (layout, fonts, headers, pagination) |
| `title-page.tex` | ISO-style title page (included by the template) |

---

## Build Requirements

### Required tools

- **Pandoc**: `3.8.3` (tested and recommended)
- **LaTeX distribution** with XeLaTeX support  
  (e.g. TeX Live 2023+, MacTeX, or equivalent)

### Required LaTeX engine

- `xelatex`  
  (required for Unicode support and ISO-style typography)

Verify Pandoc version:

```bash
pandoc --version
# pandoc 3.8.3
```

---

## Build Command

Run the following command from the repository root to generate the ISO-style PDF:

```bash
pandoc OG-AI-RSMS-001.md \
  --from=markdown+simple_tables-pipe_tables \
  --pdf-engine=xelatex \
  --template=iso-style.tex \
  --number-sections \
  -o OG-AI-RSMS-001.pdf
```

---

## Command Explanation

| Option                                      | Description                                                        |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `OG-AI-RSMS-001.md`                     | Source specification in Markdown                                   |
| `--from=markdown+simple_tables-pipe_tables` | Enables stable ISO-style tables and disables pipe tables           |
| `--pdf-engine=xelatex`                      | Uses XeLaTeX for fonts and Unicode support                         |
| `--template=iso-style.tex`                  | Applies ISO-aligned layout and formatting                          |
| `--number-sections=false`                   | Prevents duplicate numbering (ISO numbering is handled in content) |
| `-o ISO-OG-AI-RSMS-001.pdf`                 | Output PDF file                                                    |

---

## Formatting Notes

* The document follows an **ISO/IEC management system structure**, including:

  * Unnumbered *Foreword* and *Introduction*
  * Numbered clauses starting from **1 Scope**
  * Annexes labeled as **normative** or **informative**
* Tables use **Pandoc simple table syntax** to ensure stable rendering within ISO page margins.
* Horizontal rules (`---`) are intentionally avoided in the content, in line with ISO editorial practices.

---

## Reproducibility

This build process has been validated with:

* Pandoc **3.8.3**
* XeLaTeX (TeX Live 2023)
* Times New Roman font

For consistent output, use the specified versions where possible.

---

## Usage

This specification may be used as:

* an internal organizational standard;
* a reference framework for AI runtime security;
* a basis for compliance mapping and audit preparation;
* supporting documentation for regulatory or customer review.
