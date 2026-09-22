# 무붕 사이트를 Netlify로 옮기기

이 폴더는 Netlify용 전체 소스입니다. 화면은 Netlify에서, 로그인·예약 처리는 Netlify Functions에서 실행하고 기존 Supabase DB를 그대로 사용합니다. 사이트 실행에 Python·Docker·Storage 버킷은 필요하지 않습니다.

현재 Render 사이트를 먼저 지우지 마세요. 새 주소에서 확인한 뒤 전환합니다. 이 파일에 실제 비밀번호를 적거나 GitHub에 인증서를 올리지 마세요.

## 1. ZIP 풀기

`mooboong-netlify.zip`을 풀면 `mooboong-netlify` 폴더가 나옵니다. 다음 파일과 폴더가 같은 위치에 있어야 합니다.

```text
mooboong-netlify/
  netlify.toml
  package.json
  package-lock.json
  server.mjs
  schema.sql
  netlify/functions/api.mjs
  scripts/
  lib/
  public/
  tests/
  NETLIFY-START.md
  ...
```

업로드할 것은 ZIP 자체가 아니라 이 폴더 안의 내용물 전체입니다. `public` 폴더만 올리거나 Netlify Drop으로 끌어다 놓는 방식은 사용하지 않습니다. 함수까지 빌드하려면 GitHub 연결을 이용합니다.

## 2. GitHub에 새 저장소 만들기

기존 저장소와 Render 자동 배포에 영향을 주지 않도록, 개인 GitHub 계정에 `mooboong-netlify`라는 **새 저장소**를 만드는 방법을 권장합니다. Private도 가능합니다.

1. GitHub → 오른쪽 위 `+` → `New repository`.
2. 이름에 `mooboong-netlify` 입력 → `Create repository`.
3. 첫 화면의 `uploading an existing file`을 클릭합니다. 이미 파일이 있으면 `Add file → Upload files`입니다.
4. ZIP을 푼 **폴더 안의 모든 파일과 하위 폴더**를 올립니다. `netlify.toml`과 `package.json`이 저장소 첫 화면에 보여야 합니다. 폴더 한 겹 안으로 들어가지 않게 주의하세요.
5. `Commit changes`.

`.gitignore` 같은 점으로 시작하는 파일이 안 보이면 Mac Finder에서 `Command + Shift + .`을 누르세요. `node_modules`, `.env`, 인증서, DB, 백업 파일은 업로드하지 않습니다. 제공된 ZIP에는 이런 파일이 없습니다.

## 3. Netlify에 저장소 연결하기

1. https://app.netlify.com/ 에서 GitHub 계정으로 가입 또는 로그인합니다.
2. 무료 요금제를 선택합니다.
3. `Add new project → Import an existing project → GitHub`.
4. 방금 만든 `mooboong-netlify` 저장소의 접근 권한을 허용하고 선택합니다.
5. 배포 브랜치는 `main`입니다.
6. `netlify.toml` 설정이 자동 적용됩니다. 수동 입력이 필요하면 아래 값을 씁니다.

| 항목 | 값 |
| --- | --- |
| Base directory | 비워 두기 |
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `netlify/functions` |
| Node.js | `24` (`netlify.toml`에 설정됨) |

## 4. 환경변수 등록하기

배포 화면의 환경변수 항목 또는 프로젝트의 `Project configuration → Environment variables`에서 등록합니다. 키는 왼쪽 이름, 값은 오른쪽 내용입니다. **Functions에서 사용할 수 있는 범위**로 설정하세요. Scope 선택이 없으면 기본 범위를 사용합니다. 이 운영 DB 값은 Production에만 적용하고 Deploy Preview·Branch deploy에는 넣지 않는 것을 권장합니다.

| Key | Value |
| --- | --- |
| `DATABASE_URL` | 같은 Supabase 프로젝트의 PostgreSQL pooler 연결 주소 전체 |
| `PGSSLROOTCERT_PEM` | Render에서 별도 CA 인증서를 사용했다면 해당 `.crt` 파일의 텍스트 내용 전체 |
| `SETUP_TOKEN` | 기존 Render의 설정 키 또는 충분히 긴 임의 문자열. 기존 DB의 계정이 있으면 최초 설정 화면은 나오지 않습니다. 새 DB에서는 반드시 필요합니다. |

### DATABASE_URL 찾기

가장 간단한 방법은 **Render → 기존 무붕 서비스 → Environment → `DATABASE_URL`의 현재 값**을 Netlify에 옮기는 것입니다. 기존에 정상 작동한 **Session pooler 주소(5432)**도 이 버전에서 지원합니다.

서버리스에 권장하는 **Transaction pooler 주소(6543)**를 쓰려면 Supabase의 **같은 프로젝트 → Connect → Connection string → Transaction pooler**에서 복사합니다. `[YOUR-PASSWORD]`에는 그 프로젝트의 **DB 비밀번호**를 넣습니다. 비밀번호에 `@`, `#`, `/`, `%` 등이 있으면 URL 인코딩해야 합니다. 현재 작동하는 연결 주소가 있다면 비밀번호 부분을 그대로 유지할 수 있습니다.

예시 형식만 보면 다음과 같습니다. `PROJECT_REF`, 호스트, 비밀번호는 본인 프로젝트의 값이어야 합니다.

```text
postgresql://postgres.PROJECT_REF:ENCODED_PASSWORD@COPIED_POOLER_HOST:6543/postgres
```

Supabase의 프로젝트 URL(`https://....supabase.co`), anon key, publishable key, service role key를 넣는 칸이 아닙니다. Direct connection은 IPv6 문제를 일으킬 수 있으니 pooler 주소를 사용합니다. 새 프로젝트를 만들 필요가 없습니다.

### 인증서 옮기기

Render에서 `PGSSLROOTCERT=/etc/secrets/supabase-ca.crt`를 썼다면 그 **경로는 Netlify에 복사하지 않습니다.** 인증서 파일을 텍스트로 열어 아래처럼 처음부터 끝까지 복사하고 Netlify의 `PGSSLROOTCERT_PEM` 값에 넣습니다.

```text
-----BEGIN CERTIFICATE-----
여기에 원래 인증서의 모든 줄
-----END CERTIFICATE-----
```

줄바꿈을 포함해 그대로 넣습니다. 인증서 파일은 Supabase 프로젝트의 Database 연결/SSL 설정에서 다시 받을 수도 있습니다. 인증서 오류가 없는 연결에는 이 변수를 생략할 수 있습니다. 인증서 확인을 끄는 설정은 사용하지 않습니다.

### 사이트 주소

일반적인 `이름.netlify.app` 주소는 Netlify가 제공하는 사이트 URL을 자동으로 사용하므로 `APP_ORIGIN`을 먼저 만들 필요가 없습니다. 별도 도메인으로 바꾸거나 주소 관련 403 오류가 나면 `APP_ORIGIN`에 **실제로 접속할 HTTPS 주소 한 개**를 넣고 다시 배포하세요.

```text
APP_ORIGIN=https://본인-프로젝트-이름.netlify.app
```

끝에 `/#members` 같은 경로는 넣지 않습니다. 예전 Render 주소의 `APP_ORIGIN`, `HOST`, `PORT`, `PGSSLROOTCERT`, `RENDER_EXTERNAL_URL`을 Netlify로 복사하지 마세요.

## 5. 배포하고 로그인하기

1. 설정을 저장하고 배포합니다. 이미 한 번 배포했다면 `Deploys → Trigger deploy → Deploy site`로 새 배포를 시작합니다. 환경변수 변경 후에도 다시 배포해야 합니다.
2. 배포 상태가 성공하면 프로젝트의 `https://....netlify.app` 주소를 엽니다.
3. Netlify 프로젝트가 Private로 시작한 경우, 부원들이 열 수 있도록 프로젝트 공개/접근 설정을 **Public**으로 바꾸거나 Publish 안내를 완료합니다. Netlify 프로젝트 공개와 무붕 사이트 로그인 권한은 별개입니다. 무붕의 멤버·예약 API는 여전히 로그인해야 사용할 수 있습니다.
4. **기존 무붕 아이디·비밀번호로 로그인**합니다. 주소가 달라졌으므로 다시 로그인하는 것은 정상입니다.
5. 멤버, 팀, 예약, 공지, 위키를 확인합니다. 최초 운영진 생성 화면이 나오는데 기존 데이터가 있어야 한다면, 계정을 새로 만들기 전에 `DATABASE_URL`이 기존 프로젝트와 같은지 확인하세요.

처음 함수가 실행되면 필요한 보조 테이블과 인덱스를 `mooboong` 스키마에 추가합니다. 기존 멤버·예약·게시물을 삭제하거나 덮어쓰지 않습니다. SQL Editor에서 `schema.sql`을 따로 실행하지 않습니다. 빌드 단계에서는 DB에 접속하지 않습니다.

## 6. 전환 전 확인하기

- 운영진·일반부원의 로그인, 로그아웃, 비밀번호 변경.
- 기존 멤버·팀·주간 예약·예약자 표시.
- 실제 사용할 빈 시간에 테스트 예약을 만들고 취소하기.
- 반복 예약과 반복 전체 취소, 운영진 대리 예약, 커스텀 일정.
- 엑셀 검토 및 내려받기. 기존 양식을 그대로 사용합니다.
- 공지 첨부파일 내려받기와 노션 위키 열기.
- 휴대폰에서 로그인과 예약 시간표.

**두 사이트가 같은 DB를 보므로 테스트 등록·취소도 실제 데이터에 반영됩니다.** 기존 예약 대신 비어 있는 시간의 테스트 예약을 사용하세요. 화면 데이터가 다르면 계속 운영하지 말고 DB 연결을 먼저 확인합니다.

이상이 없으면 새 주소를 부원들에게 공유하거나 구매한 도메인을 Netlify에 연결합니다. 확인 후 Render 서비스를 Suspend하거나 중지합니다. Supabase 프로젝트는 지우지 않습니다. 되돌려야 하면 기존 Render를 다시 켜면 됩니다. 이 변환은 기존 버전에서 읽을 수 있는 데이터 형식을 유지합니다.

## 무료 사용의 범위와 크기 제한

- Netlify 신규 무료 요금제는 월 300크레딧입니다. 배포·접속·함수 실행 등이 사용량에 포함되며 한도를 다 쓰면 다음 주기까지 사이트가 일시 중단될 수 있습니다. 무료 계정은 자동 초과 과금이 없습니다.
- 정적 화면에 Render 서버의 기동 대기 화면은 나오지 않습니다. 함수 첫 실행과 DB 조회에는 시간이 들 수 있습니다. Netlify 무료 함수는 기본 미국 지역에서 실행되므로 기존 Supabase 위치와의 거리 때문에 모든 동작이 더 빨라진다고 보장할 수는 없습니다.
- Supabase 무료 프로젝트는 일주일간 활동이 부족하면 일시 중단될 수 있습니다. 첨부파일과 위키 이미지도 기존 DB 용량을 사용합니다.
- 엑셀은 4MB, 시트별 1,000행까지입니다. **신규 등록·비밀번호 설정을 합쳐 파일당 100명까지** 처리합니다. 기존 멤버의 비밀번호 칸을 비운 일반 정보 수정은 1,000명까지 가능합니다. 대량 신규 멤버는 100명 이하씩 나눠 올리세요.
- 첨부파일은 기존처럼 파일당 10MB, 게시물당 5개입니다. 큰 파일은 자동으로 1MB씩 나누어 전송합니다.
- 노션 HTML/ZIP 입력은 20MB까지입니다. 이미지가 내장된 최종 HTML은 18MB까지입니다. 기존 DB에 19MB를 넘는 위키 HTML이 있다면 새 사이트에서 열 수 없으므로 전환 전에 나누어 다시 가져오세요.

## 오류가 나면

| 증상 | 확인할 것 |
| --- | --- |
| 화면은 뜨는데 로그인·목록이 안 됨 | Netlify에 `api` 함수가 배포됐는지, 환경변수 적용 후 다시 배포했는지 확인 |
| `DATABASE_URL` 누락 | 환경변수 Key 철자와 Functions 적용 범위 확인 |
| `ENETUNREACH` | Supabase Direct 대신 pooler 연결 주소 사용 |
| `SELF_SIGNED_CERT_IN_CHAIN` | `PGSSLROOTCERT_PEM`에 올바른 인증서 내용 전체 등록. Render의 파일 경로는 사용 불가 |
| 비밀번호 인증 실패 | Supabase DB 비밀번호와 주소의 비밀번호 URL 인코딩 확인 |
| 로그인·저장에서 403 | 실제 접속 주소와 `APP_ORIGIN` 확인. Render 주소가 남아 있으면 삭제 또는 교체 |
| 초기 설정 화면이 갑자기 나타남 | 기존과 다른 Supabase 프로젝트에 연결했는지 확인 |
| 링크를 공유했는데 Netlify 로그인 요구 | Netlify 프로젝트의 공개 설정을 Public으로 변경 |

로그는 프로젝트의 Functions/Logs에서 `api` 함수를 선택해 확인합니다. 도움을 요청할 때는 오류 문구만 전달하고, DB 연결 주소와 비밀번호는 가려 주세요.

## 로컬 테스트와 백업

Node.js 24 이상에서 터미널을 열고 이 폴더로 이동한 다음 실행합니다.

```sh
npm ci
npm start
```

`http://127.0.0.1:4318`에서 테스트합니다. 이미 4318이 사용 중이면 다른 포트를 지정합니다.

```sh
PORT=4326 npm start
```

환경변수를 넣지 않은 로컬 실행은 별도의 SQLite 데이터입니다. 운영 Supabase 데이터가 보이지 않는 것이 정상입니다. 사이트 실행에는 Python이 필요하지 않습니다.

전체 백업은 운영진만 보관하는 `.env`에 `DATABASE_URL`과 필요한 인증서 설정을 넣고 다음 명령을 실행합니다. 실제 값을 GitHub에 올리지 마세요.

```sh
node --env-file=.env transfer-data.mjs export mooboong.backup.json
```

복원은 새 빈 DB에만 허용됩니다. 로그인 세션과 임시 업로드는 백업에 포함되지 않습니다.

```sh
node --env-file=.env transfer-data.mjs import mooboong.backup.json
```

## 공식 참고 문서

- GitHub 연결: https://docs.netlify.com/start/quickstarts/deploy-from-repository/
- 환경변수: https://docs.netlify.com/build/environment-variables/get-started/
- 함수 실행·파일 크기·지역 제한: https://docs.netlify.com/build/functions/configuration/
- Netlify 요금: https://www.netlify.com/pricing/
- Supabase 연결: https://supabase.com/docs/guides/database/connecting-to-postgres
- Supabase 요금: https://supabase.com/pricing
