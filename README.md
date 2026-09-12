# JLPT N4 학습 트래커

2026-12-06 JLPT N4 시험 대비용 개인 학습 도구입니다. 순수 HTML/CSS/JS 정적 사이트로, 빌드 과정 없이 브라우저에서 바로 동작합니다.

- 학습 계획: [STUDY_PLAN.md](./STUDY_PLAN.md)
- 오늘 체크리스트, 최근 14일 스트릭, 12주 전체 계획, 단어/문법 쪽지시험 제공
- 진행 상황은 브라우저 `localStorage`에 저장됩니다 (기기/브라우저별로 별도 저장, 서버 저장 없음)

## 로컬에서 보기

```bash
python3 -m http.server 8000
# 브라우저에서 http://localhost:8000 접속
```

## GitHub Pages 배포

`main` 브랜치에 푸시되면 `.github/workflows/deploy-pages.yml`이 자동으로 배포합니다. 최초 1회만 저장소 설정에서 활성화가 필요합니다.

1. GitHub 저장소 → **Settings** → **Pages**
2. **Build and deployment** → **Source**를 **GitHub Actions**로 변경

설정 후 `main`에 새 커밋이 올라가면 `https://<계정>.github.io/JLPT_Traning/` 에서 확인할 수 있습니다.

## 데이터 추가하기

레벨별로 `data/<level>/` 폴더에 `plan.json`(주차별 계획), `vocab.json`(단어 쪽지시험), `grammar.json`(문법 쪽지시험)을 둡니다. 현재는 `data/n4/`만 존재합니다. 새 레벨(N3 등) 추가 절차와 코드 컨벤션은 [CLAUDE.md](./CLAUDE.md)를 참고하세요.

## 테스트

```bash
npm install
npm test
```

`test/smoke.js`가 로컬 서버를 띄우고 헤드리스 브라우저로 오늘 체크/스트릭/전체 계획/쪽지시험 흐름과 날짜 경계 로직을 검증합니다. UI나 데이터를 바꾼 뒤에는 커밋 전에 실행하세요.
