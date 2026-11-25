# Strand — Product Requirements

## 1. Product purpose

The application is a desktop writing tool for fiction centred around **writing, organising and restructuring scenes**.

Its core purpose is to support a writing process in which a book develops progressively from a sparse outline into detailed prose.

A first draft may initially consist almost entirely of short beats or bullet points. Individual beats can then be expanded into scenes, those scenes can themselves be decomposed into smaller scenes, and the process can continue recursively.

The application should treat all of these stages as the same underlying work rather than separating outlining, planning and manuscript writing into different systems.

---

# 2. Narrative model

## 2.1 Narrative units

The fundamental unit of the manuscript is a **narrative node**.

Every node:

- has a unique working title;
- may contain prose;
- may contain child nodes;
- may contain both prose and child nodes;
- may currently contain neither.

The same model is used regardless of scale.

A node might conceptually represent:

- a collection;
- a book;
- a part;
- a chapter;
- a scene;
- a beat;
- a sub-scene.

These labels do not define different structural types.

The hierarchy can be arbitrarily deep.

---

## 2.2 Recursive composition

Each narrative node owns an ordered sequence of content consisting of prose and embedded narrative nodes.

Child scenes therefore occur at specific positions within the prose of their parent.

For example:

```text
Anna's Dinner

[parent prose]

    The Argument
        [child prose]

[parent prose continues]

    Anna Leaves
        [child prose]

[parent prose continues]
```

Embedded nodes retain their own identity while occupying a specific position within their parent's content.

A node whose content currently consists only of child nodes is the same kind of narrative node as one containing prose.

---

## 2.3 Extracting structure from prose

The author can select a portion of a node's text and extract it into a new child node.

The extracted text retains its original position within the enclosing prose.

This supports the core drafting workflow:

```text
rough beat
    ↓
expanded scene
    ↓
identify subsection
    ↓
extract as sub-scene
    ↓
expand independently
```

The process can be repeated recursively.

---

# 3. Progressive drafting

Planning and writing exist on a continuum.

A narrative node may begin as something as simple as:

```text
Anna confronts David about the letter.
```

That node can subsequently be expanded into prose.

Parts of that prose can then become their own child nodes and be expanded further.

There is therefore no separate conceptual distinction between:

- outline item;
- planned scene;
- rough scene;
- drafted scene;
- finished scene.

They are different states of development of the same narrative structure.

---

# 4. Editing

## 4.1 Recursive editor

Any narrative node can be opened for editing.

Opening a node displays:

- the node's own prose;
- its embedded children;
- their descendants recursively.

Opening the root book node therefore displays the entire manuscript.

There is one recursive editor model operating at any level of the hierarchy.

---

## 4.2 Scene boundaries

Embedded scene boundaries should remain visible while reading or editing the assembled prose, while remaining unobtrusive.

Nested scenes can be collapsed.

This allows the author to hide an embedded narrative while concentrating on the enclosing prose.

For example, in a story-within-a-story structure, the entire internal story could be collapsed while editing the surrounding narrative.

---

## 4.3 Editing ownership

When editing assembled prose, an edit belongs to the narrative node in which the edit began.

Structural changes are explicit operations.

---

## 4.4 Writing experience

The editor should concentrate on prose rather than document formatting.

It should provide spelling and grammar checking in a relatively unobtrusive manner.

---

# 5. Structural editing

The author must be able to:

- create nodes;
- reorder nodes;
- split nodes;
- merge nodes;
- create parent/child relationships;
- remove parent/child relationships;
- move nodes between parents;
- extract selected prose into a child node;
- reposition an embedded child within its parent's prose.

When an existing prose-bearing node is made a child of another prose-bearing node without an explicit insertion position, it is appended to the parent's content.

The author must subsequently be able to place it elsewhere within the parent's prose.

---

# 6. Book structure view

The application provides a structural view of the manuscript as a **collapsible hierarchy**.

This view allows the author to:

- understand the shape of the book;
- expand and collapse sections;
- reorder narrative nodes;
- create and change parent/child relationships;
- open nodes for editing.

The view should indicate whether a node contains prose.

---

# 7. Chronology

Book order and internal chronology are separate concepts.

The structure determines where a scene appears in the book.

Chronological information determines when the scene occurs within the narrative.

---

## 7.1 Chronological relationships

A narrative node can specify that it occurs **after another node**.

For example:

```text
A
├── B occurs after A
└── C occurs after A
```

This does not imply an ordering between B and C.

Chronology therefore supports branching narrative strands rather than requiring every scene to occupy a position in one universal sequence.

Relationships may later reconnect branches.

---

## 7.2 Optional chronological value

A node may additionally have an optional sortable chronological value.

This value may represent a real date/time, but does not have to.

Its purpose is to provide additional useful ordering within a particular book.

---

## 7.3 Timeline view

The application provides a timeline view that presents scenes according to their chronological relationships rather than their book order.

The author can use this view to:

- understand narrative chronology;
- navigate to scenes;
- move or reorganise scenes chronologically;
- work with separate or branching narrative strands.

The timeline is a representation of the chronological information held by the scenes.

---

# 8. Navigation

The two principal structural navigation mechanisms are:

- the book hierarchy;
- the narrative timeline.

Both should remain practical with a full novel containing potentially hundreds of narrative nodes.

The application also provides full-text search across the narrative content.

Search results should allow the relevant node and matching text to be opened directly.

---

# 9. Versioning

Versioning operates at two distinct levels.

## 9.1 Narrative-node versions

Each narrative node has its own independent version history.

A node's version represents the content owned directly by that node.

Changing a descendant does not create new versions of its ancestors.

For example:

```text
A v4
├── B v2
└── C v3
```

Changing C to another version does not change A from v4.

Creating a new narrative-node version is an explicit action by the author.

The author can:

- inspect a node's previous versions;
- restore an earlier version;
- compare versions.

---

## 9.2 Project versions

The project also has versions representing the composition of the work as a whole.

A project version captures at least:

- the shape and ordering of the narrative hierarchy;
- the selected version of each narrative node.

For example:

```text
Project version 17

A → v4
├── B → v2
└── C → v3
```

and:

```text
Project version 18

A → v4
├── B → v2
└── C → v1
```

These represent different assembled states even though A itself remains at version 4.

A new project version is created whenever the versioned composition changes, including changes to the narrative hierarchy or to the selected version of any narrative node.

Previous project versions can be inspected and restored.

---

# 10. Reference material

A project can contain supporting material separate from the manuscript.

This may include:

- character descriptions and biographies;
- locations;
- research notes;
- maps;
- images;
- other background material.

Reference material can be organised hierarchically and can contain text and images.

---

# 11. Metadata

Narrative nodes may carry book-defined metadata.

The metadata schema is not fixed and may vary between books.

Metadata may include front-matter-like fields or tags as appropriate to the project.

Chronological relationships and chronological sorting information are part of the core requirements.

---

# 12. Word count

The application should show:

- the word count belonging directly to a narrative node;
- the aggregate word count of that node and all of its descendants.

---

# 13. Persistence and recovery

The application should autosave work.

Loss of writing due to crashes or unexpected shutdowns should be very unusual.

Autosave cadence should balance protecting recent work against unnecessarily aggressive saving.

Autosaving and creating narrative/project versions are separate concepts.

---

# 14. Undo and redo

Normal in-session undo and redo are required.

---

# 15. Export

The application can export an assembled narrative node as a single complete document.

Exporting the root book node produces the complete manuscript in book order.

The initial required export format is **Markdown**.

The recursive structure is resolved into the assembled document during export.

---

# 16. Scale

The normal working scale is **one book at a time**.

The application should comfortably handle a full novel consisting of substantial prose and potentially hundreds of narrative nodes.

The recursive model naturally permits structures above the book level, while day-to-day operation is centred on one active book.

---

# 17. Platform

The application is a desktop application.

Windows support is sufficient for the initial product.

Cross-platform desktop support is desirable where it can be achieved without complicating the product significantly.
